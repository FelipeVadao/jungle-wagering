import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { Wallet } from './wallets/entities/wallet.entity';
import { LedgerEntry } from './wallets/entities/ledger-entry.entity';
import { WalletsModule } from './wallets/wallets.module';

import { WagerTransaction } from './wagering/entities/wager-transaction.entity';
import { WageringModule } from './wagering/wagering.module';

import { OutboxEvent } from './messaging/entities/outbox-event.entity';
import { InboxMessage } from './messaging/entities/inbox-message.entity';
import { MessagingModule } from './messaging/messaging.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      imports: [ConfigModule],
      inject: [ConfigService],

      useFactory: (config: ConfigService) => ({
        host: config.getOrThrow<string>('DB_HOST'),
        port: Number(config.getOrThrow<string>('DB_PORT')),
        dbName: config.getOrThrow<string>('DB_NAME'),
        user: config.getOrThrow<string>('DB_USER'),
        password: config.getOrThrow<string>('DB_PASSWORD'),
        metadataProvider: ReflectMetadataProvider,
        entities: [
          Wallet,
          LedgerEntry,
          WagerTransaction,
          OutboxEvent,
          InboxMessage,
        ],
        debug: true,
      }),
    }),

    MessagingModule,
    WalletsModule,
    WageringModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
