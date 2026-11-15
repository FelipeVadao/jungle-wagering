import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

/**
 * Modelo de persistência da wallet. Regras de negócio vivem no aggregate
 * `Wallet` (src/wallets/domain); aqui só há mapeamento de colunas.
 * Invariantes críticas (unicidade player+moeda, saldo >= 0) também são
 * constraints do banco — ver migrations.
 */
@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string' })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  /** numeric(20,2) hidratado como string decimal exata. */
  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balance!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: 'datetime' })
  createdAt!: Date;

  @Property({ type: 'datetime' })
  updatedAt!: Date;
}
