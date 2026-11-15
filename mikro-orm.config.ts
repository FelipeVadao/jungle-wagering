import 'dotenv/config';

import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';

import { Wallet } from './src/wallets/entities/wallet.entity';
import { LedgerEntry } from './src/wallets/entities/ledger-entry.entity';
import { WagerTransaction } from './src/wagering/entities/wager-transaction.entity';
import { OutboxEvent } from './src/messaging/entities/outbox-event.entity';
import { InboxMessage } from './src/messaging/entities/inbox-message.entity';

export default defineConfig({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  dbName: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  metadataProvider: ReflectMetadataProvider,

  entities: [
    Wallet,
    LedgerEntry,
    WagerTransaction,
    OutboxEvent,
    InboxMessage,
  ],

  extensions: [Migrator],

  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    glob: '!(*.d).{js,ts}',
    emit: 'ts',
  },

  debug: true,
});
