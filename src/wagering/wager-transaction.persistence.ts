import { EntityManager } from '@mikro-orm/postgresql';

import { Money } from '../common/domain/money';
import { WalletEntity } from '../wallets/entities/wallet.entity';

import { WagerTransaction } from './domain/wager-transaction';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';

/** Mapeamento explícito entre WagerTransaction (domínio) e a entidade. */

export function toWagerTransaction(
  entity: WagerTransactionEntity,
): WagerTransaction {
  const money = Money.from({ amount: entity.amount, currency: entity.currency });

  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.requestHash,
    walletId: entity.wallet.id,
    playerId: entity.playerId,
    roundId: entity.roundId ?? undefined,
    gameId: entity.gameId ?? undefined,
    kind: entity.type,
    money,
    referenceExternalTransactionId:
      entity.referenceExternalTransactionId ?? undefined,
    createdAt: entity.createdAt,
    status: entity.status,
    referenceTransactionId: entity.referenceTransactionId ?? undefined,
    failureCode: entity.failureCode ?? undefined,
    processedAt: entity.processedAt ?? undefined,
    observedBalance:
      entity.balanceAfter != null
        ? Money.from({ amount: entity.balanceAfter, currency: entity.currency })
        : undefined,
    attempts: entity.attempts,
    nextAttemptAt: entity.nextAttemptAt ?? undefined,
  });
}

export function createWagerTransactionEntity(
  tx: EntityManager,
  transaction: WagerTransaction,
  wallet: WalletEntity,
): WagerTransactionEntity {
  const entity = tx.create(WagerTransactionEntity, {
    id: transaction.id,
    wallet,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    requestHash: transaction.payloadHash,
    playerId: transaction.playerId,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    type: transaction.kind,
    status: transaction.status,
    amount: transaction.money.amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
    balanceAfter: transaction.observedBalance?.amount ?? null,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt ?? null,
    createdAt: transaction.createdAt,
  });

  tx.persist(entity);
  return entity;
}

/** Copia o estado mutável (status e afins) para a entidade gerenciada. */
export function applyWagerTransaction(
  transaction: WagerTransaction,
  entity: WagerTransactionEntity,
): void {
  entity.status = transaction.status;
  entity.referenceTransactionId = transaction.referenceTransactionId ?? null;
  entity.failureCode = transaction.failureCode ?? null;
  entity.processedAt = transaction.processedAt ?? null;
  entity.balanceAfter = transaction.observedBalance?.amount ?? null;
  entity.attempts = transaction.attempts;
  entity.nextAttemptAt = transaction.nextAttemptAt ?? null;
}
