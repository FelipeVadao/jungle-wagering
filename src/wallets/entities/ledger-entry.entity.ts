import {
  Entity,
  PrimaryKey,
  Property,
  ManyToOne,
  Unique,
  Index,
} from '@mikro-orm/decorators/legacy';

import { Wallet } from './wallet.entity';

export type LedgerEntryType =
  | 'OPENING'
  | 'BET'
  | 'WIN'
  | 'REFUND'
  | 'ROLLBACK';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

@Entity({ tableName: 'ledger_entries' })
@Unique({
  properties: ['wallet', 'transactionId'],
})
@Index({
  properties: ['wallet', 'createdAt'],
})
export class LedgerEntry {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => Wallet, {
    deleteRule: 'restrict',
  })
  wallet!: Wallet;

  @Property({ type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'string', length: 20 })
  type!: LedgerEntryType;

  @Property({ type: 'string', length: 10 })
  direction!: LedgerDirection;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  amount!: string;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  balanceBefore!: string;

  @Property({
    type: 'decimal',
    precision: 20,
    scale: 2,
  })
  balanceAfter!: string;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();
}
