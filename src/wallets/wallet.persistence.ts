import { EntityManager } from '@mikro-orm/postgresql';

import { Money } from '../common/domain/money';

import { Wallet } from './domain/wallet';
import { WalletLedgerEntry } from './domain/wallet-ledger-entry';
import { LedgerEntryEntity } from './entities/ledger-entry.entity';
import { WalletEntity } from './entities/wallet.entity';

/** Mapeamento explícito entre o aggregate Wallet e o modelo de persistência. */

export function toWallet(entity: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: entity.id,
    playerId: entity.playerId,
    currency: entity.currency,
    balance: Money.from({ amount: entity.balance, currency: entity.currency }),
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  });
}

export function createWalletEntity(
  tx: EntityManager,
  wallet: Wallet,
): WalletEntity {
  const entity = tx.create(WalletEntity, {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });

  tx.persist(entity);
  return entity;
}

/** Copia o estado mutável do aggregate para a entidade gerenciada (UPDATE no flush). */
export function applyWallet(wallet: Wallet, entity: WalletEntity): void {
  entity.balance = wallet.balance.amount;
  entity.version = wallet.version;
  entity.updatedAt = wallet.updatedAt;
}

export function createLedgerEntryEntity(
  tx: EntityManager,
  entry: WalletLedgerEntry,
  wallet: WalletEntity,
  kind: string,
): LedgerEntryEntity {
  const entity = tx.create(LedgerEntryEntity, {
    id: entry.id,
    wallet,
    transactionId: entry.transactionId,
    type: kind,
    direction: entry.direction,
    amount: entry.money.amount,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    createdAt: entry.createdAt,
  });

  tx.persist(entity);
  return entity;
}
