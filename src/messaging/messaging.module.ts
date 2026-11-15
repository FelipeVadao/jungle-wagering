import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { WageringModule } from '../wagering/wagering.module';

import { InboxMessageEntity } from './entities/inbox-message.entity';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { OutboxPublisher } from './outbox.publisher';
import { OutboxRelay } from './outbox.relay';
import { SqsService } from './sqs.service';
import { WagerCommandConsumer } from './wager-command.consumer';

@Module({
  imports: [
    MikroOrmModule.forFeature([OutboxEventEntity, InboxMessageEntity]),
    WageringModule,
  ],
  providers: [SqsService, OutboxPublisher, OutboxRelay, WagerCommandConsumer],
  exports: [SqsService, OutboxPublisher, OutboxRelay, WagerCommandConsumer],
})
export class MessagingModule {}
