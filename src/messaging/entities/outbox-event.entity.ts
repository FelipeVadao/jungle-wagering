import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

export type OutboxEventStatus = 'PENDING' | 'PUBLISHED';

/** Modelo de persistência da Transactional Outbox (ver OutboxMessage). */
@Entity({ tableName: 'outbox_events' })
@Index({ properties: ['status', 'createdAt'] })
export class OutboxEventEntity {
  /** = eventId do envelope; usado como MessageDeduplicationId no SQS. */
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 100 })
  eventType!: string;

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ type: 'string', length: 20 })
  status!: OutboxEventStatus;

  @Property({ type: 'integer' })
  attempts!: number;

  /** Momento a partir do qual o evento pode ser (re)publicado (backoff). */
  @Property({ type: 'datetime' })
  nextAttemptAt!: Date;

  /** occurredAt do evento. */
  @Property({ type: 'datetime' })
  createdAt!: Date;

  @Property({ type: 'datetime', nullable: true })
  publishedAt?: Date | null;

  @Property({ type: 'text', nullable: true })
  lastError?: string | null;
}
