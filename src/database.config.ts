import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';

import { InboxMessageEntity } from './messaging/entities/inbox-message.entity';
import { OutboxEventEntity } from './messaging/entities/outbox-event.entity';
import { WagerTransactionEntity } from './wagering/entities/wager-transaction.entity';
import { LedgerEntryEntity } from './wallets/entities/ledger-entry.entity';
import { WalletEntity } from './wallets/entities/wallet.entity';

export const ENTITIES = [
  WalletEntity,
  LedgerEntryEntity,
  WagerTransactionEntity,
  OutboxEventEntity,
  InboxMessageEntity,
];

type EnvReader = (key: string) => string | undefined;

/** Configuração única do MikroORM (app, CLI, scripts e testes). */
export function databaseOptions(env: EnvReader) {
  const required = (key: string): string => {
    const value = env(key);

    if (!value) {
      throw new Error(`Missing required environment variable ${key}`);
    }

    return value;
  };

  return {
    host: required('DB_HOST'),
    port: Number(required('DB_PORT')),
    dbName: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    metadataProvider: ReflectMetadataProvider,
    entities: ENTITIES,
    pool: { min: 0, max: Number(env('DB_POOL_MAX') ?? 10) },
    debug: env('DB_DEBUG') === 'true',
  };
}
