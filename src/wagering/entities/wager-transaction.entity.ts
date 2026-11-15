import {
  Entity,
  Enum,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { WalletEntity } from '../../wallets/entities/wallet.entity';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';

/**
 * Modelo de persistência de WagerTransaction. Estado e transições vivem no
 * domínio (src/wagering/domain/wager-transaction.ts).
 */
@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
@Unique({ properties: ['providerId', 'idempotencyKey'] })
@Index({ properties: ['wallet', 'createdAt'] })
@Index({ properties: ['referenceTransactionId'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletEntity, { deleteRule: 'restrict' })
  wallet!: WalletEntity;

  @Property({ type: 'string' })
  providerId!: string;

  @Property({ type: 'string' })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 255 })
  idempotencyKey!: string;

  /** SHA-256 (hex) do JSON canônico dos campos de negócio (payloadHash). */
  @Property({ type: 'string', length: 64 })
  requestHash!: string;

  @Property({ type: 'string' })
  playerId!: string;

  @Property({ type: 'string', nullable: true })
  roundId?: string | null;

  @Property({ type: 'string', nullable: true })
  gameId?: string | null;

  @Enum({ items: () => WagerTransactionKind })
  type!: WagerTransactionKind;

  @Enum({ items: () => WagerTransactionStatus })
  status!: WagerTransactionStatus;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string', length: 255, nullable: true })
  referenceExternalTransactionId?: string | null;

  @Property({ type: 'uuid', nullable: true })
  referenceTransactionId?: string | null;

  @Property({ type: 'string', length: 100, nullable: true })
  failureCode?: string | null;

  @Property({ type: 'datetime', nullable: true })
  processedAt?: Date | null;

  /** Saldo observado quando a transação atingiu o estado atual (replay). */
  @Property({ type: 'decimal', precision: 20, scale: 2, nullable: true })
  balanceAfter?: string | null;

  /** Tentativas de resolução de referência já realizadas pelo worker. */
  @Property({ type: 'integer' })
  attempts!: number;

  @Property({ type: 'datetime', nullable: true })
  nextAttemptAt?: Date | null;

  @Property({ type: 'datetime' })
  createdAt!: Date;
}
