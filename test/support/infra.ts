import { MikroORM } from '@mikro-orm/postgresql';

import config from '../../mikro-orm.config';
import { ensureQueues, topologyFromEnv } from '../../scripts/lib/sqs-bootstrap';

const state = globalThis as typeof globalThis & {
  __wageringTestInfra?: Promise<void>;
};

/**
 * Prepara (uma vez por processo de teste) o banco de teste do zero — o que
 * também exercita todas as migrations — e as filas FIFO de teste, vazias.
 */
export function ensureTestInfrastructure(): Promise<void> {
  state.__wageringTestInfra ??= setup();
  return state.__wageringTestInfra;
}

async function setup(): Promise<void> {
  const dbName = process.env.DB_NAME;

  if (!dbName || !dbName.endsWith('_test')) {
    throw new Error(`Refusing to recreate non-test database "${dbName}"`);
  }

  await recreateDatabase(dbName);

  // snapshot: false — o banco de teste é descartável; não deve gerar/alterar
  // arquivos de snapshot em src/migrations.
  const orm = await MikroORM.init({
    ...config,
    migrations: { ...config.migrations, snapshot: false },
  });

  try {
    await orm.migrator.up();
  } finally {
    await orm.close(true);
  }

  await ensureQueues(topologyFromEnv(), { purge: true });
}

/** Recria um banco descartável de teste (nunca o de desenvolvimento). */
export async function recreateDatabase(name: string): Promise<void> {
  await withAdmin(name, async (execute) => {
    await execute(`drop database if exists "${name}" with (force)`);
    await execute(`create database "${name}"`);
  });
}

/** Remove um banco descartável de teste. */
export async function dropDatabase(name: string): Promise<void> {
  await withAdmin(name, async (execute) => {
    await execute(`drop database if exists "${name}" with (force)`);
  });
}

async function withAdmin(
  name: string,
  work: (execute: (sql: string) => Promise<unknown>) => Promise<void>,
): Promise<void> {
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`Refusing to touch database "${name}"`);
  }

  const admin = await MikroORM.init({ ...config, dbName: 'postgres', pool: { min: 0, max: 1 } });

  try {
    await work((sql) => admin.em.fork().execute(sql));
  } finally {
    await admin.close(true);
  }
}
