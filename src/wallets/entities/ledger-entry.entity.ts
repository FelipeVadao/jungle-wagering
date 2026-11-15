import {
  Entity,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { WalletEntity } from './wallet.entity';

/**
 * Lançamento do ledger (append-only). O banco bloqueia UPDATE/DELETE/TRUNCATE
 * via trigger e valida `balance_before ± amount = balance_after` via CHECK.
 *
 * A coluna `sequence` (identity) não é mapeada: é gerada pelo banco e usada
 * apenas pela paginação por cursor (consulta nativa).
 */
@Entity({ tableName: 'ledger_entries' })
@Unique({ properties: ['wallet', 'transactionId'] })
@Index({ properties: ['wallet', 'createdAt'] })
export class LedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletEntity, { deleteRule: 'restrict' })
  wallet!: WalletEntity;

  @Property({ type: 'uuid' })
  transactionId!: string;

  /** Kind da transação de origem (OPENING, BET, WIN, REFUND, ROLLBACK). */
  @Property({ type: 'string', length: 20 })
  type!: string;

  @Property({ type: 'string', length: 10 })
  direction!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceBefore!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'datetime' })
  createdAt!: Date;
}
