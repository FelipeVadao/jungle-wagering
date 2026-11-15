import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_messages' })
@Unique({
  properties: ['consumerName', 'messageId'],
})
export class InboxMessage {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 100 })
  consumerName!: string;

  @Property({ type: 'string', length: 255 })
  messageId!: string;

  @Property({ type: 'datetime' })
  processedAt: Date = new Date();
}
