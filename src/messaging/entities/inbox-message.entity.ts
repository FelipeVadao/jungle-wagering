import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

/** Modelo de persistência da Inbox (deduplicação por consumer + messageId). */
@Entity({ tableName: 'inbox_messages' })
@Unique({ properties: ['consumerName', 'messageId'] })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 100 })
  consumerName!: string;

  @Property({ type: 'string', length: 255 })
  messageId!: string;

  /** SHA-256 do corpo bruto da mensagem (null em registros legados). */
  @Property({ type: 'string', length: 64, nullable: true })
  payloadHash?: string | null;

  @Property({ type: 'datetime' })
  receivedAt!: Date;

  @Property({ type: 'datetime' })
  processedAt!: Date;
}
