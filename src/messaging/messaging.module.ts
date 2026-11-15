import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { WageringModule } from '../wagering/wagering.module';

import { OutboxEvent } from './entities/outbox-event.entity';
import { InboxMessage } from './entities/inbox-message.entity';

import { SqsService } from './sqs.service';
import { OutboxPublisher } from './outbox.publisher';
import { WagerCommandConsumer } from './wager-command.consumer';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      OutboxEvent,
      InboxMessage,
    ]),
    WageringModule,
  ],
  providers: [
    SqsService,
    OutboxPublisher,
    WagerCommandConsumer,
  ],
  exports: [
    SqsService,
    OutboxPublisher,
    WagerCommandConsumer,
  ],
})
export class MessagingModule {}
