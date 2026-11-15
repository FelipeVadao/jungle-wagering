
import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';

import { Money } from '../common/domain/money';
import { Wallet } from '../wallets/entities/wallet.entity';
import {
  LedgerEntry,
  LedgerDirection,
  LedgerEntryType,
} from '../wallets/entities/ledger-entry.entity';
import { OutboxEvent } from '../messaging/entities/outbox-event.entity';

import {
  WagerTransaction,
  WagerTransactionStatus,
  WagerTransactionType,
} from './entities/wager-transaction.entity';

import {
  ProcessBetDto,
  WagerOperationType,
} from './dto/process-bet.dto';

@Injectable()
export class WageringService {
  constructor(
    private readonly em: EntityManager,
  ) {}

  /**
   * Processamento utilizado pela API REST.
   * Abre uma transação própria.
   */
  async processBet(
    dto: ProcessBetDto,
    idempotencyKey: string,
  ) {
    return this.em.transactional(async (tx) => {
      return this.processBetInTransaction(
        tx,
        dto,
        idempotencyKey,
      );
    });
  }

  /**
   * Processa uma operação dentro de uma transação existente.
   * Utilizado também pelo Consumer SQS para garantir
   * atomicidade entre Inbox e processamento financeiro.
   */
  async processBetInTransaction(
    tx: EntityManager,
    dto: ProcessBetDto,
    idempotencyKey: string,
  ) {
    const normalizedKey = idempotencyKey.trim();

    if (
      normalizedKey.length === 0 ||
      normalizedKey.length > 255
    ) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }

    const requestHash = this.createRequestHash(dto);

    // 1. Serializa requisições com a mesma chave idempotente.
    const lockKey = `${dto.providerId}:${normalizedKey}`;

    await tx.execute(
      'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
      [lockKey],
    );

    // 2. Verifica idempotência.
    const existing = await tx.findOne(WagerTransaction, {
      providerId: dto.providerId,
      idempotencyKey: normalizedKey,
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException(
          'Idempotency key already used with a different payload',
        );
      }

      return this.toResponse(existing);
    }

    // 3. Impede reutilização da transação externa.
    const externalTransaction = await tx.findOne(
      WagerTransaction,
      {
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
      },
    );

    if (externalTransaction) {
      throw new ConflictException(
        'External transaction already exists',
      );
    }

    // 4. Bloqueia a carteira durante o processamento.
    const wallet = await tx.findOne(
      Wallet,
      { id: dto.walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    if (wallet.playerId !== dto.playerId) {
      throw new BadRequestException(
        'Wallet does not belong to the informed player',
      );
    }

    if (wallet.currency !== dto.money.currency) {
      throw new BadRequestException(
        'Wallet currency does not match transaction currency',
      );
    }

    // 5. Valida o valor usando aritmética exata.
    const amount = Money.fromDecimal(
      dto.money.amount,
      wallet.currency,
    );

    const zero = Money.fromDecimal(
      '0.00',
      wallet.currency,
    );

    if (amount.compare(zero) <= 0) {
      throw new BadRequestException(
        'Amount must be greater than zero',
      );
    }

    const currentBalance = Money.fromDecimal(
      wallet.balance,
      wallet.currency,
    );

    // 6. Cria a transação.
    const transaction = tx.create(WagerTransaction, {
      id: randomUUID(),
      wallet,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      type: dto.kind,
      status: WagerTransactionStatus.PENDING,
      amount: dto.money.amount,
      roundId: dto.roundId,
      gameId: dto.gameId,
      referenceExternalTransactionId:
        dto.referenceExternalTransactionId,
      idempotencyKey: normalizedKey,
      requestHash,
      createdAt: new Date(),
    });

    // 7. Operações com referência: REFUND e ROLLBACK.
    let referenceTransaction: WagerTransaction | null = null;

    if (
      dto.kind === WagerOperationType.REFUND ||
      dto.kind === WagerOperationType.ROLLBACK
    ) {
      if (!dto.referenceExternalTransactionId) {
        throw new BadRequestException(
          'Reference transaction ID is required',
        );
      }

      // Serializa reversões concorrentes da mesma transação.
      const referenceLockKey =
        `${dto.providerId}:${dto.referenceExternalTransactionId}:${dto.kind}`;

      await tx.execute(
        'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
        [referenceLockKey],
      );

      referenceTransaction = await tx.findOne(
        WagerTransaction,
        {
          providerId: dto.providerId,
          externalTransactionId:
            dto.referenceExternalTransactionId,
        },
      );

      // A referência pode chegar depois.
      // Não rejeitamos: registramos como pendente.
      if (!referenceTransaction) {
        transaction.status =
          WagerTransactionStatus.PENDING_REFERENCE;

        tx.persist(transaction);

        this.createOutboxEvent(tx, {
          eventType: 'WagerTransactionPendingReference',
          transactionId: transaction.id,
          walletId: wallet.id,
          providerId: dto.providerId,
          externalTransactionId: dto.externalTransactionId,
          referenceExternalTransactionId:
            dto.referenceExternalTransactionId,
          type: dto.kind,
          createdAt: new Date().toISOString(),
        }, transaction.id);

        await tx.flush();

        return this.toResponse(transaction);
      }

      // A referência precisa estar processada.
      if (
        referenceTransaction.status !==
        WagerTransactionStatus.PROCESSED
      ) {
        throw new ConflictException(
          'Reference transaction is not processed',
        );
      }

      // Valida se a referência pertence à mesma operação financeira.
      const referenceWallet = referenceTransaction.wallet;

      if (
        referenceTransaction.providerId !== dto.providerId ||
        referenceWallet.id !== wallet.id ||
        referenceWallet.playerId !== dto.playerId ||
        referenceWallet.currency !== wallet.currency ||
        referenceTransaction.roundId !== dto.roundId
      ) {
        throw new BadRequestException(
          'Reference transaction does not match the original operation',
        );
      }

      // REFUND só pode reverter BET.
      if (
        dto.kind === WagerOperationType.REFUND &&
        referenceTransaction.type !== WagerTransactionType.BET
      ) {
        throw new BadRequestException(
          'REFUND must reference a processed BET',
        );
      }

      // ROLLBACK pode reverter BET, WIN ou REFUND.
      if (
        dto.kind === WagerOperationType.ROLLBACK &&
        ![
          WagerTransactionType.BET,
          WagerTransactionType.WIN,
          WagerTransactionType.REFUND,
        ].includes(referenceTransaction.type)
      ) {
        throw new BadRequestException(
          'ROLLBACK must reference a processed BET, WIN or REFUND',
        );
      }

      // A operação de reversão deve ter o mesmo valor.
      if (referenceTransaction.amount !== dto.money.amount) {
        throw new BadRequestException(
          'Reversal amount must match the reference transaction',
        );
      }

      // Impede duas reversões do mesmo tipo sobre a mesma origem.
      const previousReversal = await tx.findOne(
        WagerTransaction,
        {
          referenceTransactionId: referenceTransaction.id,
          type: dto.kind,
          status: {
            $in: [
              WagerTransactionStatus.PENDING_REFERENCE,
              WagerTransactionStatus.PROCESSED,
            ],
          },
        },
      );

      if (previousReversal) {
        throw new ConflictException(
          'Reference transaction has already been reversed with this operation type',
        );
      }

      transaction.referenceTransactionId =
        referenceTransaction.id;
    }

    // 8. Determina o efeito financeiro.
    let newBalance = currentBalance;
    let balanceChanged = false;
    let ledgerDirection: LedgerDirection | null = null;
    let ledgerType: LedgerEntryType | null = null;

    switch (dto.kind) {
      case WagerOperationType.BET: {
        if (currentBalance.compare(amount) < 0) {
          transaction.status =
            WagerTransactionStatus.REJECTED;

          transaction.failureCode = 'INSUFFICIENT_FUNDS';

          this.createOutboxEvent(tx, {
            eventType: 'WagerTransactionRejected',
            transactionId: transaction.id,
            walletId: wallet.id,
            providerId: dto.providerId,
            type: dto.kind,
            amount: dto.money.amount,
            currency: wallet.currency,
            reason: 'INSUFFICIENT_FUNDS',
            createdAt: new Date().toISOString(),
          }, transaction.id);

          tx.persist(transaction);
          await tx.flush();

          return this.toResponse(transaction);
        }

        newBalance = currentBalance.subtract(amount);
        balanceChanged = true;
        ledgerDirection = 'DEBIT';
        ledgerType = 'BET';

        break;
      }

      case WagerOperationType.WIN: {
        newBalance = currentBalance.add(amount);
        balanceChanged = true;
        ledgerDirection = 'CREDIT';
        ledgerType = 'WIN';

        break;
      }

      case WagerOperationType.LOSS: {
        // LOSS registra a operação, mas não movimenta a carteira.
        break;
      }

      case WagerOperationType.REFUND: {
        newBalance = currentBalance.add(amount);
        balanceChanged = true;
        ledgerDirection = 'CREDIT';
        ledgerType = 'REFUND';

        break;
      }

      case WagerOperationType.ROLLBACK: {
        if (!referenceTransaction) {
          throw new BadRequestException(
            'ROLLBACK reference transaction is required',
          );
        }

        // Inverte o efeito financeiro da operação original.
        switch (referenceTransaction.type) {
          case WagerTransactionType.BET: {
            newBalance = currentBalance.add(amount);
            ledgerDirection = 'CREDIT';
            break;
          }

          case WagerTransactionType.WIN:
          case WagerTransactionType.REFUND: {
            if (currentBalance.compare(amount) < 0) {
              transaction.status =
                WagerTransactionStatus.REJECTED;

              transaction.failureCode =
                'ROLLBACK_INSUFFICIENT_FUNDS';

              this.createOutboxEvent(tx, {
                eventType: 'WagerTransactionRejected',
                transactionId: transaction.id,
                walletId: wallet.id,
                providerId: dto.providerId,
                type: dto.kind,
                amount: dto.money.amount,
                currency: wallet.currency,
                reason: 'ROLLBACK_INSUFFICIENT_FUNDS',
                createdAt: new Date().toISOString(),
              }, transaction.id);

              tx.persist(transaction);
              await tx.flush();

              return this.toResponse(transaction);
            }

            newBalance = currentBalance.subtract(amount);
            ledgerDirection = 'DEBIT';
            break;
          }

          default:
            throw new BadRequestException(
              'Unsupported rollback reference type',
            );
        }

        balanceChanged = true;
        ledgerType = 'ROLLBACK';

        break;
      }
    }

    // 9. Atualiza a carteira somente quando há mudança de saldo.
    if (balanceChanged) {
      wallet.balance = newBalance.toDecimalString();
      wallet.version += 1;
    }

    transaction.status = WagerTransactionStatus.PROCESSED;
    transaction.processedAt = new Date();

    // 10. Cria o lançamento financeiro somente quando necessário.
    if (balanceChanged && ledgerDirection && ledgerType) {
      const ledgerEntry = tx.create(LedgerEntry, {
        id: randomUUID(),
        wallet,
        transactionId: transaction.id,
        type: ledgerType,
        direction: ledgerDirection,
        amount: dto.money.amount,
        balanceBefore: currentBalance.toDecimalString(),
        balanceAfter: newBalance.toDecimalString(),
        createdAt: new Date(),
      });

      tx.persist(ledgerEntry);
    }

    // 11. Evento de operação processada.
    // Inclui LOSS, mesmo sem movimentação financeira.
    this.createOutboxEvent(tx, {
      eventType: 'WagerTransactionProcessed',
      transactionId: transaction.id,
      walletId: wallet.id,
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      type: transaction.type,
      amount: transaction.amount,
      currency: wallet.currency,
      balanceAfter: wallet.balance,
      walletVersion: wallet.version,
      createdAt: new Date().toISOString(),
    }, transaction.id);

    // 12. Evento de alteração do saldo somente quando necessário.
    if (balanceChanged) {
      this.createOutboxEvent(tx, {
        eventType: 'WalletBalanceChanged',
        transactionId: transaction.id,
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balanceBefore: currentBalance.toDecimalString(),
        balanceAfter: newBalance.toDecimalString(),
        walletVersion: wallet.version,
        createdAt: new Date().toISOString(),
      }, wallet.id);
    }

    // 13. Persiste tudo na mesma transação SQL.
    tx.persist(transaction);

    await tx.flush();

    return this.toResponse(transaction);
  }

  /**
   * Cria eventos na Outbox.
   * A publicação acontece posteriormente, após o commit.
   */
  private createOutboxEvent(
    tx: EntityManager,
    payload: Record<string, unknown>,
    aggregateId: string,
  ) {
    const eventType = String(payload.eventType);

    const outboxEvent = tx.create(OutboxEvent, {
      id: randomUUID(),
      eventType,
      aggregateId,
      payload,
      status: 'PENDING',
      attempts: 0,
      createdAt: new Date(),
    });

    tx.persist(outboxEvent);
  }

  /**
   * Hash determinístico do conteúdo completo da requisição.
   */
  private createRequestHash(dto: ProcessBetDto): string {
    const payload = {
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: {
        amount: dto.money.amount,
        currency: dto.money.currency,
      },
      referenceExternalTransactionId:
        dto.referenceExternalTransactionId ?? null,
    };

    return createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  private toResponse(transaction: WagerTransaction) {
    return {
      transactionId: transaction.id,
      walletId: transaction.wallet.id,
      providerId: transaction.providerId,
      externalTransactionId:
        transaction.externalTransactionId,
      type: transaction.type,
      status: transaction.status,
      amount: transaction.amount,
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      failureCode: transaction.failureCode,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
    };
  }
}
