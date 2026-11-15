import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LockMode } from '@mikro-orm/core';
import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';

import { Money, MoneyProps } from '../common/domain/money';
import { RetryPolicy } from '../common/domain/retry-policy';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidIdempotencyKeyError,
  TransactionNotFoundError,
  WalletNotFoundError,
} from '../common/errors/application-errors';
import {
  isLockConflictError,
  isTransientError,
} from '../common/errors/transient-error';
import { enqueueIntegrationEvent } from '../messaging/outbox.writer';
import { MetricsService } from '../observability/metrics.service';
import { Wallet } from '../wallets/domain/wallet';
import { WalletBalanceChanged } from '../wallets/domain/wallet-balance-changed.event';
import { WalletEntity } from '../wallets/entities/wallet.entity';
import {
  applyWallet,
  createLedgerEntryEntity,
  toWallet,
} from '../wallets/wallet.persistence';

import { computeWagerPayloadHash, WagerPayloadFields } from './domain/payload-hash';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './domain/wager-transaction';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from './domain/wager-transaction.events';
import {
  settleWagerTransaction,
  SettlementOutcome,
} from './domain/wager-settlement';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import {
  applyWagerTransaction,
  createWagerTransactionEntity,
  toWagerTransaction,
} from './wager-transaction.persistence';

export interface SubmitWagerCommand extends WagerPayloadFields {
  idempotencyKey: string;
}

export interface ProcessingContext {
  channel: 'http' | 'sqs' | 'worker';
  correlationId: string;
  causationId?: string;
}

export interface WagerSubmissionResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balance: MoneyProps | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

/** Espera pelo lock da wallet acima disso conta como contenção. */
const LOCK_CONTENTION_THRESHOLD_SECONDS = 0.005;

@Injectable()
export class WageringService {
  private readonly logger = new Logger(WageringService.name);
  private readonly lockTimeoutMs: number;
  readonly referenceRetryPolicy: RetryPolicy;

  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.lockTimeoutMs = positiveInt(config.get('DB_LOCK_TIMEOUT_MS'), 5000);
    this.referenceRetryPolicy = new RetryPolicy(
      positiveInt(config.get('PENDING_REFERENCE_BASE_DELAY_MS'), 1000),
      positiveInt(config.get('PENDING_REFERENCE_MAX_DELAY_MS'), 60_000),
      positiveInt(config.get('PENDING_REFERENCE_MAX_ATTEMPTS'), 10),
    );
  }

  /** Entrada HTTP: abre a própria transação SQL. */
  async submit(
    command: SubmitWagerCommand,
    ctx: ProcessingContext,
  ): Promise<WagerSubmissionResult> {
    return this.em
      .fork()
      .transactional((tx) => this.submitInTransaction(tx, command, ctx));
  }

  /**
   * Use case único (HTTP e SQS). Executa dentro da transação recebida para
   * que inbox, transação, ledger, saldo e outbox sejam confirmados juntos.
   *
   * Ordem de locks (sempre a mesma, sem ciclos):
   *   1. advisory lock da Idempotency-Key (serializa duplicatas concorrentes);
   *   2. lock de linha da wallet (FOR UPDATE) — unidade de concorrência.
   */
  async submitInTransaction(
    tx: EntityManager,
    command: SubmitWagerCommand,
    ctx: ProcessingContext,
  ): Promise<WagerSubmissionResult> {
    const startedAt = performance.now();
    const idempotencyKey = normalizeIdempotencyKey(command.idempotencyKey);
    const payloadHash = computeWagerPayloadHash(command);

    await this.setLockTimeout(tx);
    await tx.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
      `idempotency:${command.providerId}:${idempotencyKey}`,
    ]);

    const existing = await tx.findOne(
      WagerTransactionEntity,
      { providerId: command.providerId, idempotencyKey },
      { disableIdentityMap: true },
    );

    if (existing) {
      if (existing.requestHash !== payloadHash) {
        this.metrics.increment('idempotency_conflicts_total', {
          channel: ctx.channel,
          source: 'idempotency_key',
        });
        throw new IdempotencyConflictError(
          'Idempotency-Key already used with a different payload',
        );
      }

      this.metrics.increment('idempotency_duplicates_total', {
        channel: ctx.channel,
        source: 'idempotency_key',
      });

      return { transaction: toWagerTransaction(existing), idempotentReplay: true };
    }

    const externalIdTaken = await tx.count(WagerTransactionEntity, {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
    });

    if (externalIdTaken > 0) {
      throw new ExternalTransactionConflictError(
        'externalTransactionId already registered under another Idempotency-Key',
      );
    }

    const walletEntity = await this.lockWallet(tx, command.walletId);

    if (!walletEntity) {
      throw new WalletNotFoundError(`Wallet ${command.walletId} not found`);
    }

    const now = new Date();
    const wallet = toWallet(walletEntity);
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey,
      payloadHash,
      walletId: wallet.id,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    const outcome = await this.settle(tx, wallet, transaction, now);

    createWagerTransactionEntity(tx, transaction, walletEntity);
    this.persistOutcome(tx, walletEntity, wallet, transaction, outcome, ctx, now, false);

    try {
      await tx.flush();
    } catch (error) {
      // Corrida entre chaves diferentes para o mesmo externalTransactionId em
      // wallets distintas: a constraint única do banco é a garantia final.
      if (error instanceof UniqueConstraintViolationException) {
        throw new ExternalTransactionConflictError(
          'Transaction conflicts with a concurrently registered transaction',
        );
      }

      throw error;
    }

    this.recordOutcome(transaction, ctx, startedAt);

    return { transaction, idempotentReplay: false };
  }

  async findById(transactionId: string): Promise<WagerTransactionView> {
    const entity = await this.em
      .fork()
      .findOne(
        WagerTransactionEntity,
        { id: transactionId },
        { disableIdentityMap: true },
      );

    if (!entity) {
      throw new TransactionNotFoundError(`Transaction ${transactionId} not found`);
    }

    return toWagerTransactionView(toWagerTransaction(entity));
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const entity = await this.em
      .fork()
      .findOne(
        WagerTransactionEntity,
        { providerId, externalTransactionId },
        { disableIdentityMap: true },
      );

    if (!entity) {
      throw new TransactionNotFoundError(
        `Transaction ${providerId}/${externalTransactionId} not found`,
      );
    }

    return toWagerTransactionView(toWagerTransaction(entity));
  }

  // ------------------------------------------------ PENDING_REFERENCE worker

  /**
   * Reprocessa transações PENDING_REFERENCE vencidas. Seguro com várias
   * instâncias: cada item é tratado sob o lock da sua wallet e relido depois
   * do lock; quem chegar depois encontra o estado já alterado e ignora.
   */
  async retryDuePendingReferences(limit = 50): Promise<number> {
    const due = await this.em.fork().find(
      WagerTransactionEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        nextAttemptAt: { $lte: new Date() },
      },
      {
        orderBy: { nextAttemptAt: 'asc' },
        limit,
        disableIdentityMap: true,
      },
    );

    let handled = 0;

    for (const candidate of due) {
      try {
        if (await this.retryPendingReference(candidate.id)) {
          handled += 1;
        }
      } catch (error) {
        this.logger.error({
          msg: 'pending_reference.retry_failed',
          transactionId: candidate.id,
          walletId: candidate.wallet.id,
          providerId: candidate.providerId,
          error: errorMessage(error),
        });

        if (!isTransientError(error)) {
          await this.markFailed(candidate.id);
        }
      }
    }

    return handled;
  }

  /** Retorna true se a transação foi efetivamente reavaliada. */
  async retryPendingReference(transactionId: string): Promise<boolean> {
    return this.em.fork().transactional(async (tx) => {
      const snapshot = await tx.findOne(
        WagerTransactionEntity,
        { id: transactionId },
        { disableIdentityMap: true },
      );

      if (!snapshot || snapshot.status !== WagerTransactionStatus.PendingReference) {
        return false;
      }

      await this.setLockTimeout(tx);

      const walletEntity = await this.lockWallet(tx, snapshot.wallet.id);

      if (!walletEntity) {
        return false;
      }

      // Releitura sob o lock da wallet: outra instância pode ter resolvido.
      const entity = await tx.findOne(WagerTransactionEntity, { id: transactionId });
      const now = new Date();

      if (
        !entity ||
        entity.status !== WagerTransactionStatus.PendingReference ||
        (entity.nextAttemptAt && entity.nextAttemptAt.getTime() > now.getTime())
      ) {
        return false;
      }

      const wallet = toWallet(walletEntity);
      const transaction = toWagerTransaction(entity);
      const outcome = await this.settle(tx, wallet, transaction, now);
      const ctx: ProcessingContext = {
        channel: 'worker',
        correlationId: transaction.id,
        causationId: 'pending-reference-worker',
      };

      applyWagerTransaction(transaction, entity);
      this.persistOutcome(tx, walletEntity, wallet, transaction, outcome, ctx, now, true);
      await tx.flush();

      this.metrics.increment('pending_reference_retries_total', {
        outcome: outcome.type,
      });
      this.recordOutcome(transaction, ctx);

      return true;
    });
  }

  private async markFailed(transactionId: string): Promise<void> {
    try {
      await this.em.fork().transactional(async (tx) => {
        const entity = await tx.findOne(WagerTransactionEntity, { id: transactionId });

        if (!entity || entity.status !== WagerTransactionStatus.PendingReference) {
          return;
        }

        const transaction = toWagerTransaction(entity);
        transaction.fail(FailureCode.ProcessingError, new Date());
        applyWagerTransaction(transaction, entity);
        await tx.flush();

        this.metrics.increment('wager_transactions_total', {
          status: transaction.status,
          kind: transaction.kind,
          channel: 'worker',
        });
      });
    } catch (error) {
      this.logger.error({
        msg: 'pending_reference.mark_failed_error',
        transactionId,
        error: errorMessage(error),
      });
    }
  }

  // ------------------------------------------------------------- internals

  private async settle(
    tx: EntityManager,
    wallet: Wallet,
    transaction: WagerTransaction,
    now: Date,
  ): Promise<SettlementOutcome> {
    let reference: WagerTransaction | null = null;
    let referenceAlreadyReversed = false;

    if (transaction.referenceExternalTransactionId) {
      const referenceEntity = await tx.findOne(
        WagerTransactionEntity,
        {
          providerId: transaction.providerId,
          externalTransactionId: transaction.referenceExternalTransactionId,
        },
        { disableIdentityMap: true },
      );

      reference = referenceEntity ? toWagerTransaction(referenceEntity) : null;

      if (reference && transaction.isReversal()) {
        referenceAlreadyReversed =
          (await tx.count(WagerTransactionEntity, {
            referenceTransactionId: reference.id,
            type: {
              $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
            },
            status: WagerTransactionStatus.Processed,
          })) > 0;
      }
    }

    return settleWagerTransaction({
      wallet,
      transaction,
      reference,
      referenceAlreadyReversed,
      retryPolicy: this.referenceRetryPolicy,
      ledgerEntryId: randomUUID(),
      now,
    });
  }

  private persistOutcome(
    tx: EntityManager,
    walletEntity: WalletEntity,
    wallet: Wallet,
    transaction: WagerTransaction,
    outcome: SettlementOutcome,
    ctx: ProcessingContext,
    now: Date,
    isRetry: boolean,
  ): void {
    const eventCtx = {
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: now,
    };

    switch (outcome.type) {
      case 'processed':
        if (outcome.ledgerEntry) {
          applyWallet(wallet, walletEntity);
          createLedgerEntryEntity(tx, outcome.ledgerEntry, walletEntity, transaction.kind);
          enqueueIntegrationEvent(
            tx,
            WalletBalanceChanged.from(wallet, outcome.ledgerEntry, eventCtx),
          );
        }

        enqueueIntegrationEvent(
          tx,
          WagerTransactionProcessed.from(transaction, wallet, eventCtx),
        );
        break;

      case 'rejected':
        enqueueIntegrationEvent(tx, WagerTransactionRejected.from(transaction, eventCtx));
        break;

      case 'pending-reference':
        // Só a primeira chegada publica o evento; reagendamentos não.
        if (!isRetry) {
          enqueueIntegrationEvent(
            tx,
            WagerTransactionPendingReference.from(transaction, eventCtx),
          );
        }
        break;
    }
  }

  private async lockWallet(
    tx: EntityManager,
    walletId: string,
  ): Promise<WalletEntity | null> {
    const startedAt = performance.now();

    try {
      const wallet = await tx.findOne(
        WalletEntity,
        { id: walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      const waitedSeconds = (performance.now() - startedAt) / 1000;

      this.metrics.observe('wallet_lock_wait_seconds', waitedSeconds);

      if (waitedSeconds > LOCK_CONTENTION_THRESHOLD_SECONDS) {
        this.metrics.increment('wallet_lock_conflicts_total', { reason: 'contention' });
      }

      return wallet;
    } catch (error) {
      if (isLockConflictError(error)) {
        this.metrics.increment('wallet_lock_conflicts_total', {
          reason: 'timeout_or_deadlock',
        });
      }

      throw error;
    }
  }

  /** lock_timeout limita a espera por locks (advisory e de linha) da transação. */
  private async setLockTimeout(tx: EntityManager): Promise<void> {
    await tx.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
  }

  private recordOutcome(
    transaction: WagerTransaction,
    ctx: ProcessingContext,
    startedAt?: number,
  ): void {
    this.metrics.increment('wager_transactions_total', {
      status: transaction.status,
      kind: transaction.kind,
      channel: ctx.channel,
    });

    if (startedAt !== undefined) {
      this.metrics.observe(
        'wager_processing_duration_seconds',
        (performance.now() - startedAt) / 1000,
        { channel: ctx.channel },
      );
    }

    // Sem valores monetários nem payload completo nos logs.
    this.logger.log({
      msg: 'wager.transaction.settled',
      correlationId: ctx.correlationId,
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode,
      channel: ctx.channel,
    });
  }
}

export function toWagerTransactionView(
  transaction: WagerTransaction,
): WagerTransactionView {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    balance: transaction.observedBalance?.toJSON() ?? null,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

function normalizeIdempotencyKey(key: string | undefined): string {
  const normalized = key?.trim() ?? '';

  if (normalized.length === 0 || normalized.length > 255) {
    throw new InvalidIdempotencyKeyError(
      'Idempotency-Key must have between 1 and 255 characters',
    );
  }

  return normalized;
}

export function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
