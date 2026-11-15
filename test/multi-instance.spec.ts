import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';

import { CONSUMER_NAME } from '../src/messaging/wager-command.consumer';
import { SqsService } from '../src/messaging/sqs.service';

import {
  countRows,
  createTestApp,
  createWallet,
  expectLedgerConsistent,
  TestWallet,
  transactionsOf,
  wager,
  WagerBody,
  waitFor,
  walletState,
} from './support/app';
import {
  Instance,
  killInstance,
  postJson,
  freePort,
  spawnBun,
  startInstance,
} from './support/instances';

const INSTANCE_ENV = { DB_POOL_MAX: '10' };

function command(wallet: TestWallet, amount: string) {
  const externalTransactionId = `mi-${randomUUID()}`;

  return {
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-test',
      externalTransactionId,
      idempotencyKey: `provider-test:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    },
  };
}

const keyOf = (body: WagerBody) => ({
  'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
});

/**
 * Processos do SO separados (`bun src/main.ts`), cada um com seu pool de
 * conexões, consumer SQS, relay de outbox e worker de PENDING_REFERENCE,
 * sobre o mesmo PostgreSQL e as mesmas filas.
 */
describe('Múltiplas instâncias (processos reais)', () => {
  let app: INestApplication;
  let sqs: SqsService;
  const running: Instance[] = [];

  const inboxCount = (messageIds: string[]) =>
    countRows(
      app,
      `select 1 from "inbox_messages"
        where "consumer_name" = ? and "message_id" in (${messageIds.map(() => '?').join(', ')})`,
      [CONSUMER_NAME, ...messageIds],
    );

  async function start(name: string): Promise<Instance> {
    const instance = await startInstance(name, await freePort(), INSTANCE_ENV);
    running.push(instance);
    return instance;
  }

  async function stop(instance: Instance): Promise<void> {
    await killInstance(instance);
    running.splice(running.indexOf(instance), 1);
  }

  beforeAll(async () => {
    app = await createTestApp();
    sqs = app.get(SqsService);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(running.map((instance) => killInstance(instance)));
    await app?.close();
  }, 60_000);

  it(
    'worker morto depois do commit e antes do ack: a redelivery não duplica o débito após o reinício',
    async () => {
      const wallet = await createWallet(app, '100.00');
      const envelope = command(wallet, '10.00');
      await sqs.publishCommand(envelope, wallet.id, randomUUID());

      const crashing = spawnBun('crash-consumer', [
        'test/support/crash-consumer.ts',
        envelope.messageId,
      ]);
      const exitCode = await crashing.exited;

      expect({ exitCode, output: exitCode === 137 ? '' : crashing.output() }).toEqual({
        exitCode: 137,
        output: '',
      });

      // O commit aconteceu antes da morte: transação, ledger, saldo e inbox.
      const [transaction] = await transactionsOf(
        app,
        'provider-test',
        envelope.data.externalTransactionId,
      );
      expect(transaction?.status).toBe('PROCESSED');
      expect(await inboxCount([envelope.messageId])).toBe(1);
      expect(await walletState(app, wallet.id)).toMatchObject({ balance: '90.00', debits: 1 });

      // Reinício: uma instância nova recebe a redelivery (mensagem sem ack).
      const restarted = await start('restarted-consumer');

      await waitFor(
        async () => {
          const metrics = await (await fetch(`${restarted.url}/metrics`)).text();
          return /idempotency_duplicates_total\{[^}]*source="inbox"[^}]*\} [1-9]/.test(metrics);
        },
        30_000,
        250,
      );

      expect(
        await transactionsOf(app, 'provider-test', envelope.data.externalTransactionId),
      ).toHaveLength(1);
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '90.00',
        version: 2,
        debits: 1,
      });
      await expectLedgerConsistent(app, wallet.id);
      await stop(restarted);
    },
    120_000,
  );

  it(
    'três instâncias simultâneas: disputa de saldo, duplicatas, consumers concorrentes e relays da outbox',
    async () => {
      const instances = await Promise.all([start('instance-a'), start('instance-b'), start('instance-c')]);
      const urls = instances.map((instance) => `${instance.url}/wagering/transactions`);

      // 1) 30 BETs de 10.00 disputando 100.00, distribuídas entre as instâncias.
      const hot = await createWallet(app, '100.00');
      const bets = Array.from({ length: 30 }, () => wager(hot, 'BET', '10.00'));
      const betResults = await Promise.all(
        bets.map((body, index) => postJson(urls[index % 3], body, keyOf(body))),
      );

      expect(betResults.filter((result) => result.status === 201)).toHaveLength(10);
      expect(
        betResults.filter(
          (result) => result.status === 422 && result.body.failureCode === 'INSUFFICIENT_FUNDS',
        ),
      ).toHaveLength(20);
      expect(await walletState(app, hot.id)).toMatchObject({
        balance: '0.00',
        version: 11,
        debits: 10,
      });

      // 2) A mesma aposta 15 vezes em cada instância (45 envios simultâneos).
      const dup = await createWallet(app, '100.00');
      const duplicated = wager(dup, 'BET', '10.00');
      const dupResults = await Promise.all(
        Array.from({ length: 45 }, (_, index) =>
          postJson(urls[index % 3], duplicated, keyOf(duplicated)),
        ),
      );

      expect(dupResults.every((result) => result.status === 201)).toBe(true);
      expect(new Set(dupResults.map((result) => result.body.transactionId)).size).toBe(1);
      expect(dupResults.filter((result) => result.body.idempotentReplay === false)).toHaveLength(1);
      expect(await walletState(app, dup.id)).toMatchObject({ balance: '90.00', debits: 1 });

      // 3) Consumers das 3 instâncias competindo pela fila, com reenvios
      //    duplicados (novo messageId, mesma Idempotency-Key).
      const sqsWallets = await Promise.all([1, 2, 3].map(() => createWallet(app, '100.00')));
      const envelopes = sqsWallets.flatMap((wallet) =>
        Array.from({ length: 6 }, () => command(wallet, '5.00')),
      );
      const resent = envelopes.slice(0, 6).map((envelope) => ({
        ...envelope,
        messageId: randomUUID(),
      }));

      for (const envelope of [...envelopes, ...resent]) {
        await sqs.publishCommand(envelope, envelope.data.walletId, randomUUID());
      }

      const allMessageIds = [...envelopes, ...resent].map((envelope) => envelope.messageId);
      await waitFor(async () => (await inboxCount(allMessageIds)) === allMessageIds.length, 60_000, 250);

      for (const wallet of sqsWallets) {
        expect(await walletState(app, wallet.id)).toMatchObject({
          balance: '70.00',
          version: 7,
          debits: 6,
        });
      }

      for (const envelope of envelopes) {
        expect(
          await transactionsOf(app, 'provider-test', envelope.data.externalTransactionId),
        ).toHaveLength(1);
      }

      // 4) Os relays das 3 instâncias drenam a outbox (nenhum evento perdido).
      await waitFor(
        async () =>
          (await countRows(app, `select 1 from "outbox_events" where "status" = 'PENDING'`)) === 0,
        60_000,
        250,
      );

      for (const wallet of [hot, dup, ...sqsWallets]) {
        await expectLedgerConsistent(app, wallet.id);
      }

      await Promise.all(instances.map((instance) => stop(instance)));
    },
    180_000,
  );

  it(
    'instância morta no meio das requisições: após o reinício, reenvios idempotentes completam sem duplicar',
    async () => {
      const victim = await start('victim');
      const wallet = await createWallet(app, '200.00');
      const bodies = Array.from({ length: 150 }, () => wager(wallet, 'BET', '1.00'));
      const url = `${victim.url}/wagering/transactions`;

      const inflight = bodies.map((body) =>
        postJson(url, body, keyOf(body)).catch(() => ({ status: 0, body: {} })),
      );

      // Mata o processo assim que a primeira resposta chega: o resto está em voo.
      await Promise.race(inflight);
      await stop(victim);
      const beforeCrash = await Promise.all(inflight);

      const committed = await countRows(
        app,
        `select 1 from "wager_transactions" where "wallet_id" = ? and "type" = 'BET'`,
        [wallet.id],
      );

      // Atomicidade: o que foi confirmado está inteiro (saldo == ledger).
      expect(committed).toBeGreaterThan(0);
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: (200 - committed).toFixed(2),
        debits: committed,
      });
      await expectLedgerConsistent(app, wallet.id);
      expect(beforeCrash.filter((result) => result.status === 201).length).toBeLessThanOrEqual(
        committed,
      );

      const restarted = await start('restarted-http');
      const retried = await Promise.all(
        bodies.map((body) =>
          postJson(`${restarted.url}/wagering/transactions`, body, keyOf(body)),
        ),
      );

      expect(retried.every((result) => result.status === 201)).toBe(true);
      expect(retried.filter((result) => result.body.idempotentReplay === true)).toHaveLength(
        committed,
      );
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '50.00',
        version: 151,
        debits: 150,
      });

      // O relay da instância reiniciada publica o que ficou pendente.
      await waitFor(
        async () =>
          (await countRows(
            app,
            `select 1 from "outbox_events" o
               join "wager_transactions" t on t."id" = o."aggregate_id"
              where t."wallet_id" = ? and o."status" = 'PENDING'`,
            [wallet.id],
          )) === 0,
        30_000,
        250,
      );
      await expectLedgerConsistent(app, wallet.id);
      await stop(restarted);
    },
    180_000,
  );
});
