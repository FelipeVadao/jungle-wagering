import {
  Entity,
  PrimaryKey,
  Property,
  Index,
} from '@mikro-orm/decorators/legacy';

export type OutboxEventStatus = 'PENDING' | 'PUBLISHED';

@Entity({ tableName: 'outbox_events' })
@Index({ properties: ['status', 'createdAt'] })
export class OutboxEvent {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 100 })
  eventType!: string;

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ type: 'string', length: 20 })
  status: OutboxEventStatus = 'PENDING';

  @Property({ type: 'integer' })
  attempts: number = 0;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  publishedAt?: Date;

  @Property({ type: 'text', nullable: true })
  lastError?: string;
}
