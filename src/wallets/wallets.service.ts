import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';

import { Money, MoneyProps } from '../common/domain/money';
import {
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../common/errors/application-errors';
import { enqueueIntegrationEvent } from '../messaging/outbox.writer';
import { MetricsService } from '../observability/metrics.service';
import { canonicalJson, sha256Hex } from '../wagering/domain/payload-hash';
import { WagerTransaction } from '../wagering/domain/wager-transaction';
import { WagerTransactionProcessed } from '../wagering/domain/wager-transaction.events';
import { createWagerTransactionEntity } from '../wagering/wager-transaction.persistence';

import { Wallet } from './domain/wallet';
import { WalletBalanceChanged } from './domain/wallet-balance-changed.event';
import { WalletEntity } from './entities/wallet.entity';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import {
  createLedgerEntryEntity,
  createWalletEntity,
  toWallet,
} from './wallet.persistence';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  kind: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  walletId: string;
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export const LEDGER_PAGE_DEFAULT_LIMIT = 50;
export const LEDGER_PAGE_MAX_LIMIT = 200;

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Cria a wallet. Saldo inicial > 0 gera, na MESMA transação SQL, a
   * transação interna OPENING (PROCESSED), o lançamento CREDIT e os eventos.
   */
  async create(
    input: { playerId: string; initialBalance: MoneyProps },
    correlationId: string,
  ): Promise<WalletView> {
    const initialBalance = Money.from(input.initialBalance);
    const now = new Date();
    const walletId = randomUUID();
    const openingTransactionId = randomUUID();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: randomUUID(),
      now,
    });

    try {
      await this.em.fork().transactional(async (tx) => {
        const walletEntity = createWalletEntity(tx, wallet);

        if (openingEntry) {
          const opening = WagerTransaction.createOpening({
            id: openingTransactionId,
            walletId,
            playerId: wallet.playerId,
            money: initialBalance,
            payloadHash: sha256Hex(
              canonicalJson({
                walletId,
                playerId: wallet.playerId,
                initialBalance: initialBalance.toJSON(),
              }),
            ),
            now,
          });

          createWagerTransactionEntity(tx, opening, walletEntity);
          createLedgerEntryEntity(tx, openingEntry, walletEntity, opening.kind);

          const ctx = { correlationId, occurredAt: now };
          enqueueIntegrationEvent(tx, WagerTransactionProcessed.from(opening, wallet, ctx));
          enqueueIntegrationEvent(tx, WalletBalanceChanged.from(wallet, openingEntry, ctx));
        }

        await tx.flush();
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(
          `Wallet already exists for player ${input.playerId} in ${initialBalance.currency}`,
        );
      }

      throw error;
    }

    this.logger.log({
      msg: 'wallet.created',
      walletId,
      correlationId,
      version: wallet.version,
    });

    return toWalletView(wallet);
  }

  async findById(walletId: string): Promise<WalletView> {
    const entity = await this.em
      .fork()
      .findOne(WalletEntity, { id: walletId }, { disableIdentityMap: true });

    if (!entity) {
      throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    }

    return toWalletView(toWallet(entity));
  }

  /** Lançamentos do mais recente para o mais antigo, paginados por keyset. */
  async findLedger(
    walletId: string,
    cursor: string | undefined,
    limit = LEDGER_PAGE_DEFAULT_LIMIT,
  ): Promise<LedgerPage> {
    const em = this.em.fork();
    const wallet = await em.findOne(
      WalletEntity,
      { id: walletId },
      { disableIdentityMap: true },
    );

    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    }

    const afterSequence = cursor ? decodeLedgerCursor(cursor, walletId) : null;
    const pageSize = Math.min(Math.max(limit, 1), LEDGER_PAGE_MAX_LIMIT);

    const rows = await em.execute<
      Array<{
        id: string;
        transaction_id: string;
        type: string;
        direction: string;
        amount: string;
        balance_before: string;
        balance_after: string;
        created_at: Date | string;
        sequence_text: string;
      }>
    >(
      // O alias NÃO pode se chamar "sequence": o ORDER BY resolveria para a
      // coluna de saída (text) e ordenaria lexicograficamente ('100' < '99').
      `select "id", "transaction_id", "type", "direction", "amount",
              "balance_before", "balance_after", "created_at",
              "sequence"::text as "sequence_text"
         from "ledger_entries"
        where "wallet_id" = ?
          and (?::bigint is null or "sequence" < ?::bigint)
        order by "ledger_entries"."sequence" desc
        limit ?`,
      [walletId, afterSequence, afterSequence, pageSize + 1],
    );

    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    const money = (amount: string) =>
      Money.from({ amount, currency: wallet.currency }).toJSON();

    return {
      walletId,
      items: page.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        kind: row.type,
        direction: row.direction,
        money: money(row.amount),
        balanceBefore: money(row.balance_before),
        balanceAfter: money(row.balance_after),
        createdAt: new Date(row.created_at).toISOString(),
      })),
      nextCursor:
        rows.length > pageSize && last
          ? encodeLedgerCursor(walletId, last.sequence_text)
          : null,
    };
  }

  /**
   * Compara o saldo materializado com o saldo reconstruído pelo ledger numa
   * única instrução SQL (snapshot consistente). Divergências NÃO são
   * corrigidas: são logadas, contabilizadas em métrica e sinalizadas.
   */
  async reconcile(walletId: string): Promise<ReconciliationReport> {
    const [row] = await this.em.fork().execute<
      Array<{
        balance: string;
        currency: string;
        credits: string;
        debits: string;
        entries: number;
      }>
    >(
      `select w."balance", w."currency",
              coalesce(sum(l."amount") filter (where l."direction" = 'CREDIT'), 0)::text as "credits",
              coalesce(sum(l."amount") filter (where l."direction" = 'DEBIT'), 0)::text as "debits",
              count(l."id")::int as "entries"
         from "wallets" w
         left join "ledger_entries" l on l."wallet_id" = w."id"
        where w."id" = ?
        group by w."id"`,
      [walletId],
    );

    if (!row) {
      throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    }

    const currency = row.currency;
    const stored = Money.from({ amount: row.balance, currency });
    const calculated = Money.from({ amount: row.credits, currency }).subtract(
      Money.from({ amount: row.debits, currency }),
    );
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();

    this.metrics.increment('reconciliation_runs_total', {
      result: consistent ? 'consistent' : 'mismatch',
    });

    if (!consistent) {
      this.metrics.increment('reconciliation_mismatches_total');
      this.logger.error({
        msg: 'wallet.reconciliation.mismatch',
        walletId,
        checkedEntries: row.entries,
      });
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: row.entries,
    };
  }
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}
