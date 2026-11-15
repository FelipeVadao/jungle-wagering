import { MikroORM } from '@mikro-orm/postgresql';

import config from '../mikro-orm.config';

/**
 * bun run migration:up | migration:down | migration:status
 * (equivalente à CLI do MikroORM, executado diretamente pelo Bun).
 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const orm = await MikroORM.init(config);

  try {
    switch (command) {
      case 'up': {
        const applied = await orm.migrator.up();
        console.log(`Applied ${applied.length} migration(s)`, applied.map((m) => m.name));
        break;
      }
      case 'down': {
        const reverted = await orm.migrator.down();
        console.log(`Reverted ${reverted.length} migration(s)`, reverted.map((m) => m.name));
        break;
      }
      case 'status': {
        const executed = await orm.migrator.getExecuted();
        const pending = await orm.migrator.getPending();
        console.log('Executed:', executed.map((m) => m.name));
        console.log('Pending :', pending.map((m) => m.name));
        break;
      }
      default:
        throw new Error(`Unknown command ${command}`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
