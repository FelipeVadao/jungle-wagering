import 'dotenv/config';
import 'reflect-metadata';

import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { databaseOptions } from './src/database.config';

/** Usado pela CLI do MikroORM, pelos scripts e pelos testes. */
export default defineConfig({
  ...databaseOptions((key) => process.env[key]),
  extensions: [Migrator],
  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    glob: '!(*.d).{js,ts}',
    emit: 'ts',
  },
});
