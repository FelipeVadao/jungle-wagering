import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

import config from '../mikro-orm.config';

import {
  createTestApp,
  createWallet,
  em,
  submit,
  TestWallet,
  wager,
} from './support/app';
import { dropDatabase, recreateDatabase } from './support/infra';

/**
 * As garantias de unicidade, imutabilidade e não-negatividade valem no
 * SCHEMA (seção 5.9 do desafio): aqui o banco é atacado diretamente por SQL,
 * contornando a aplicação.
 */
describe('Schema: migrations e constraints (PostgreSQL real)', () => {
  let app: INestApplication;

  const sql = (query: string, params: unknown[] = []) => em(app).execute(query, params);

  beforeAll(async () => {
    app = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 60_000);

  it(
    'todas as migrations sobem, revertem até o início e sobem de novo (reversíveis)',
    async () => {
      const scratch = 'wagering_migrations_test';
      const files = readdirSync(join(__dirname, '..', 'src', 'migrations')).filter((file) =>
        /^Migration\d+\.ts$/.test(file),
      );

      await recreateDatabase(scratch);
      const orm = await MikroORM.init({
        ...config,
        dbName: scratch,
        pool: { min: 0, max: 2 },
        migrations: { ...config.migrations, snapshot: false, silent: true },
      });

      const tables = async () =>
        (
          await orm.em
            .fork()
            .execute<Array<{ table_name: string }>>(
              `select table_name from information_schema.tables
                where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
                order by table_name`,
            )
        ).map((row) => row.table_name);

      try {
        expect(await orm.migrator.up()).toHaveLength(files.length);
        expect(await tables()).toEqual([
          'inbox_messages',
          'ledger_entries',
          'outbox_events',
          'wager_transactions',
          'wallets',
        ]);

        expect(await orm.migrator.down({ to: 0 })).toHaveLength(files.length);
        expect(await orm.migrator.getExecuted()).toHaveLength(0);
        expect(await tables()).toEqual([]);

        expect(await orm.migrator.up()).toHaveLength(files.length);
        expect(await orm.migrator.getPending()).toHaveLength(0);
      } finally {
        await orm.close(true);
        await dropDatabase(scratch);
      }
    },
    120_000,
  );

  describe('constraints e triggers', () => {
    let wallet: TestWallet;

    beforeEach(async () => {
      wallet = await createWallet(app, '100.00');
    });

    it('saldo nunca negativo (CHECK)', async () => {
      await expect(
        sql(`update "wallets" set "balance" = -0.01 where "id" = ?`, [wallet.id]),
      ).rejects.toThrow(/wallets_balance_non_negative/);
    });

    it('wallet única por player + moeda (UNIQUE)', async () => {
      await expect(
        sql(
          `insert into "wallets" ("id", "player_id", "currency", "balance", "version")
           values (?, ?, 'BRL', 0, 1)`,
          [randomUUID(), wallet.playerId],
        ),
      ).rejects.toThrow(/wallets_player_id_currency_unique/);
    });

    it('ledger é append-only: UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
      await expect(
        sql(`update "ledger_entries" set "amount" = "amount" + 1 where "wallet_id" = ?`, [
          wallet.id,
        ]),
      ).rejects.toThrow(/append-only/);
      await expect(
        sql(`delete from "ledger_entries" where "wallet_id" = ?`, [wallet.id]),
      ).rejects.toThrow(/append-only/);
      await expect(sql(`truncate "ledger_entries"`)).rejects.toThrow(/append-only/);

      const [{ count }] = (await sql(
        `select count(*)::int as "count" from "ledger_entries" where "wallet_id" = ?`,
        [wallet.id],
      )) as Array<{ count: number }>;
      expect(count).toBe(1);
    });

    it('lançamento desbalanceado ou com valor não positivo é rejeitado (CHECK)', async () => {
      const insertEntry = (amount: string, before: string, after: string) =>
        sql(
          `insert into "ledger_entries"
             ("id", "wallet_id", "transaction_id", "type", "direction", "amount",
              "balance_before", "balance_after", "created_at")
           values (?, ?, ?, 'BET', 'DEBIT', ?, ?, ?, now())`,
          [randomUUID(), wallet.id, randomUUID(), amount, before, after],
        );

      await expect(insertEntry('10.00', '100.00', '95.00')).rejects.toThrow(
        /ledger_entries_balanced/,
      );
      await expect(insertEntry('0.00', '100.00', '100.00')).rejects.toThrow(
        /ledger_entries_amount_positive/,
      );
      await expect(insertEntry('10.00', '5.00', '-5.00')).rejects.toThrow(
        /ledger_entries_balances_non_negative|ledger_entries_balanced/,
      );
    });

    it('transação terminal não pode ser alterada (trigger)', async () => {
      const response = await submit(app, wager(wallet, 'BET', '10.00')).expect(201);

      await expect(
        sql(
          `update "wager_transactions" set "status" = 'REJECTED', "failure_code" = 'X' where "id" = ?`,
          [response.body.transactionId],
        ),
      ).rejects.toThrow(/is terminal/);
    });

    it('idempotência no banco: (provider, idempotency_key) e (provider, external_id) únicos', async () => {
      const body = wager(wallet, 'WIN', '1.00');
      const response = await submit(app, body).expect(201);
      const copy = (overrides: string) =>
        sql(copyTransactionSql(overrides), [response.body.transactionId]);

      await expect(
        copy(`'external_transaction_id', s."external_transaction_id" || '-other'`),
      ).rejects.toThrow(/wager_transactions_provider_id_idempotency_key_unique/);
      await expect(copy(`'idempotency_key', s."idempotency_key" || '-other'`)).rejects.toThrow(
        /wager_transactions_provider_id_external_transaction_id_unique/,
      );
    });

    it('uma referência só pode ser revertida uma vez (índice único parcial)', async () => {
      const bet = wager(wallet, 'BET', '10.00');
      await submit(app, bet).expect(201);
      const refund = await submit(
        app,
        wager(wallet, 'REFUND', '10.00', {
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      ).expect(201);

      await expect(
        sql(
          copyTransactionSql(
            `'external_transaction_id', s."external_transaction_id" || '-dup',
             'idempotency_key', s."idempotency_key" || '-dup'`,
          ),
          [refund.body.transactionId],
        ),
      ).rejects.toThrow(/wager_transactions_single_reversal_unique/);
    });

    it('inbox única por (consumer, messageId)', async () => {
      const insert = () =>
        sql(
          `insert into "inbox_messages" ("id", "consumer_name", "message_id", "processed_at")
           values (?, 'schema-test', 'same-message', now())`,
          [randomUUID()],
        );

      await insert();
      await expect(insert()).rejects.toThrow(/inbox_messages_consumer_name_message_id_unique/);
    });

    it('outbox: PUBLISHED exige published_at (CHECK)', async () => {
      const [event] = (await sql(
        `select "id" from "outbox_events" where "aggregate_id" = ? limit 1`,
        [wallet.id],
      )) as Array<{ id: string }>;

      await expect(
        sql(`update "outbox_events" set "status" = 'PUBLISHED' where "id" = ?`, [event.id]),
      ).rejects.toThrow(/outbox_events_published_at_check/);
    });
  });
});

/**
 * Copia uma transação existente (todas as colunas) sobrescrevendo campos:
 * `overrides` é a lista de pares de `jsonb_build_object` sobre a linha `s`.
 */
function copyTransactionSql(overrides: string): string {
  return `insert into "wager_transactions"
          select (jsonb_populate_record(
                    null::"wager_transactions",
                    to_jsonb(s) || jsonb_build_object('id', gen_random_uuid(), ${overrides})
                 )).*
            from "wager_transactions" s
           where s."id" = ?`;
}
