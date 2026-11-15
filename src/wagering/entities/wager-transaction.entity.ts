import {
  Entity,
  PrimaryKey,
  Property,
  Enum,
  Unique,
  Index,
  ManyToOne,
} from '@mikro-orm/decorators/legacy';

import { Wallet } from '../../wallets/entities/wallet.entity';

export enum WagerTransactionType {
  BET = 'BET',
  WIN = 'WIN',
  LOSS = 'LOSS',
  REFUND = 'REFUND',
  ROLLBACK = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  PENDING = 'PENDING',
  PENDING_REFERENCE = 'PENDING_REFERENCE',
  PROCESSED = 'PROCESSED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

@Entity({ tableName: 'wager_transactions' })
@Unique({
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  properties: ['providerId', 'idempotencyKey'],
})
@Index({
  properties: ['wallet', 'createdAt'],
})
@Index({
  properties: ['referenceTransactionId'],
})
export class WagerTransaction {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => Wallet, {
    deleteRule: 'restrict',
  })
  wallet!: Wallet;

  @Property({ type: 'string' })
  providerId!: string;

  @Property({ type: 'string' })
  externalTransactionId!: string;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  amount!: string;

  @Property({ type: 'string', nullable: true })
  roundId?: string;

  @Property({ type: 'string', nullable: true })
  gameId?: string;

  @Property({
    type: 'string',
    length: 255,
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @Property({
    type: 'uuid',
    nullable: true,
  })
  referenceTransactionId?: string;

  @Property({
    type: 'string',
    length: 100,
    nullable: true,
  })
  failureCode?: string;

  @Property({
    type: 'datetime',
    nullable: true,
  })
  processedAt?: Date;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ type: 'string', length: 255 })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 64 })
  requestHash!: string;

  @Enum({
    items: () => WagerTransactionType,
  })
  type!: WagerTransactionType;

  @Enum({
    items: () => WagerTransactionStatus,
  })
  status!: WagerTransactionStatus;
}
