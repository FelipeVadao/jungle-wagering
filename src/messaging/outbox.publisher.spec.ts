import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/postgresql';

import { createTestApp, waitFor } from '../../test/support/app';
import { MetricsService } from '../observability/metrics.service';
import { WalletsService } from '../wallets/wallets.service';

import { OutboxEventEntity } from './entities/outbox-event.entity';
import { OutboxPublisher } from './outbox.publisher';
import { SqsService } from './sqs.service';

/** Eventos de teste ficam no passado para estarem sempre no início da fila. */
const BASE_TIME = Date.parse('2000-01-01T00:00:00.000Z');
let clock = 0;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Simula o processo morrendo DEPOIS do envio ao SQS e ANTES do commit: o
 * trabalho do publisher roda, mas a transação é desfeita no final.
 */
function crashingBeforeCommit(base: EntityManager): EntityManager {
  return {
    fork: () => {
      const forked = base.fork();
      return {
        transactional: <T>(work: (tx: EntityManager) => Promise<T>) =>
          forked.transactional(async (tx) => {
            await work(tx);
            throw new Error('processo morreu antes do commit (simulado)');
          }),
      };
    },
  } as unknown as EntityManager;
}

describe('OutboxPublisher (integration)', () => {
  let app: INestApplication;
  let em: EntityManager;
  let sqs: SqsService;
  let metrics: MetricsService;
  let config: ConfigService;

  const newPublisher = (entityManager: EntityManager = em) =>
    new OutboxPublisher(entityManager, sqs, metrics, config);

  async function insertEvents(
    count: number,
    aggregateIdFor: (index: number) => string = () => randomUUID(),
  ): Promise<OutboxEventEntity[]> {
    const fork = em.fork();
    const entities: OutboxEventEntity[] = [];

    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      const aggregateId = aggregateIdFor(index);
      const createdAt = new Date(BASE_TIME + (clock += 1));

      entities.push(
        fork.create(OutboxEventEntity, {
          id,
          eventType: 'WagerTransactionProcessed',
          aggregateId,
          payload: { eventId: id, aggregateId, test: 'outbox-integration' },
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: createdAt,
          createdAt,
          publishedAt: null,
          lastError: null,
        }),
      );
    }

    await fork.flush();
    return entities;
  }

  const reload = (id: string) =>
    em.fork().findOneOrFail(OutboxEventEntity, { id }, { disableIdentityMap: true });

  beforeAll(async () => {
    app = await createTestApp();
    em = app.get(EntityManager).fork();
    sqs = app.get(SqsService);
    metrics = app.get(MetricsService);
    config = app.get(ConfigService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 60_000);

  it(
    'não deve publicar o mesmo evento quando dois publicadores executam simultaneamente',
    async () => {
      const [event] = await insertEvents(1);
      const eventId = event.id;
      const publishGate = deferred();
      const publishEntered = deferred();
      const originalPublishEvent = sqs.publishEvent.bind(sqs);

      // O gate segura SOMENTE o evento-alvo; os demais seguem direto.
      const publishSpy = jest
        .spyOn(sqs, 'publishEvent')
        .mockImplementation(async (payload, messageGroupId, publishedEventId) => {
          if (publishedEventId === eventId) {
            publishEntered.resolve();
            await publishGate.promise;
          }

          return originalPublishEvent(payload, messageGroupId, publishedEventId);
        });

      const countTargetEventCalls = () =>
        publishSpy.mock.calls.filter(([, , publishedEventId]) => publishedEventId === eventId)
          .length;

      let firstExecution: Promise<number> | undefined;
      let secondExecution: Promise<number> | undefined;

      try {
        firstExecution = newPublisher().publishPending();

        await Promise.race([
          publishEntered.promise,
          firstExecution.then(() => {
            throw new Error('O primeiro publicador terminou sem chegar ao envio do SQS.');
          }),
        ]);

        // O primeiro publicador está DENTRO do envio, segurando o lock da linha.
        secondExecution = newPublisher().publishPending();

        const secondResult = await Promise.race([
          secondExecution.then(() => 'completed'),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
        ]);

        expect(secondResult).toBe('completed');
        expect(countTargetEventCalls()).toBe(1);

        publishGate.resolve();
        await firstExecution;

        expect(countTargetEventCalls()).toBe(1);

        const updatedEvent = await reload(eventId);

        expect(updatedEvent.status).toBe('PUBLISHED');
        expect(updatedEvent.attempts).toBe(0);
        expect(updatedEvent.publishedAt).toBeInstanceOf(Date);
        expect(updatedEvent.lastError == null).toBe(true);
      } finally {
        publishGate.resolve();
        await firstExecution?.catch(() => undefined);
        await secondExecution?.catch(() => undefined);
        publishSpy.mockRestore();
      }
    },
    30_000,
  );

  it(
    'vários publishers concorrentes publicam cada evento exatamente uma vez',
    async () => {
      const events = await insertEvents(40);
      const targetIds = new Set(events.map((event) => event.id));
      const publishSpy = jest.spyOn(sqs, 'publishEvent');

      try {
        const publishers = [newPublisher(), newPublisher(), newPublisher(), newPublisher()];

        await Promise.all(
          publishers.map(async (publisher) => {
            for (let round = 0; round < 50; round += 1) {
              if ((await publisher.publishPending(5)) === 0) {
                break;
              }
            }
          }),
        );

        // Sobra possível: linhas puladas (SKIP LOCKED) quando outro publisher
        // as segurava no momento em que um publisher encerrou o loop.
        while ((await newPublisher().publishPending(50)) > 0) {
          // drena
        }

        const callsPerEvent = new Map<string, number>();

        for (const [, , eventId] of publishSpy.mock.calls) {
          if (targetIds.has(eventId)) {
            callsPerEvent.set(eventId, (callsPerEvent.get(eventId) ?? 0) + 1);
          }
        }

        expect(callsPerEvent.size).toBe(events.length);
        expect([...callsPerEvent.values()].every((calls) => calls === 1)).toBe(true);

        const rows = await em
          .fork()
          .find(OutboxEventEntity, { id: { $in: [...targetIds] } }, { disableIdentityMap: true });

        expect(rows).toHaveLength(events.length);
        expect(rows.every((row) => row.status === 'PUBLISHED' && row.attempts === 0)).toBe(true);
      } finally {
        publishSpy.mockRestore();
      }
    },
    60_000,
  );

  it(
    'falha no SQS: agenda retry com backoff, não perde o evento e não publica os posteriores do mesmo agregado antes dele',
    async () => {
      const aggregateId = randomUUID();
      const [first, second] = await insertEvents(2, () => aggregateId);
      const originalPublishEvent = sqs.publishEvent.bind(sqs);
      const sent: string[] = [];
      let sqsAvailable = false;

      const publishSpy = jest
        .spyOn(sqs, 'publishEvent')
        .mockImplementation(async (payload, messageGroupId, eventId) => {
          if (eventId === first.id && !sqsAvailable) {
            throw new Error('SQS indisponível (simulado)');
          }

          const result = await originalPublishEvent(payload, messageGroupId, eventId);
          sent.push(eventId);
          return result;
        });

      try {
        const before = Date.now();
        await newPublisher().publishPending();

        const failed = await reload(first.id);
        const blocked = await reload(second.id);

        expect(failed.status).toBe('PENDING');
        expect(failed.attempts).toBe(1);
        expect(failed.lastError).toContain('SQS indisponível');
        expect(failed.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 1000);
        expect(blocked.status).toBe('PENDING');
        expect(blocked.attempts).toBe(0);

        // Antes do backoff vencer: o primeiro não é retentado e o segundo
        // continua bloqueado atrás dele (inclusive em outro lote).
        await newPublisher().publishPending();
        expect((await reload(second.id)).status).toBe('PENDING');
        expect(sent).not.toContain(second.id);

        sqsAvailable = true;

        await waitFor(
          async () => {
            await newPublisher().publishPending();
            return (await reload(second.id)).status === 'PUBLISHED';
          },
          15_000,
          200,
        );

        const recovered = await reload(first.id);

        expect(recovered.status).toBe('PUBLISHED');
        expect(recovered.attempts).toBe(1);
        expect(sent.filter((id) => id === first.id || id === second.id)).toEqual([
          first.id,
          second.id,
        ]);
      } finally {
        publishSpy.mockRestore();
      }
    },
    30_000,
  );

  it(
    'processo morre após publicar e antes do commit: outra instância republica com o mesmo eventId',
    async () => {
      const [event] = await insertEvents(1);
      const publishSpy = jest.spyOn(sqs, 'publishEvent');

      try {
        await expect(newPublisher(crashingBeforeCommit(em)).publishPending()).rejects.toThrow(
          'antes do commit',
        );

        const afterCrash = await reload(event.id);
        expect(afterCrash.status).toBe('PENDING');
        expect(afterCrash.attempts).toBe(0);

        await newPublisher().publishPending();

        const published = await reload(event.id);
        const calls = publishSpy.mock.calls.filter(([, , eventId]) => eventId === event.id);

        expect(published.status).toBe('PUBLISHED');
        // at-least-once: 2 envios, mesmo eventId (MessageDeduplicationId),
        // mesmo grupo e mesmo payload — o consumidor deduplica pelo eventId.
        expect(calls).toHaveLength(2);
        expect(calls[1][0]).toEqual(calls[0][0]);
        expect(calls[1][1]).toBe(calls[0][1]);
      } finally {
        publishSpy.mockRestore();
      }
    },
    30_000,
  );

  it(
    'evento confirmado e não publicado (processo morreu antes de publicar) é publicado por outra instância',
    async () => {
      // Evento real gravado na mesma transação da criação da wallet.
      const response = await fetchWalletCreation();
      const pending = await em
        .fork()
        .find(OutboxEventEntity, { aggregateId: response.walletId }, { disableIdentityMap: true });

      expect(pending.length).toBeGreaterThan(0);
      expect(pending.every((row) => row.status === 'PENDING')).toBe(true);

      // "Outra instância": um publisher novo, sem estado em memória.
      await waitFor(
        async () => {
          await newPublisher().publishPending();
          const rows = await em
            .fork()
            .find(
              OutboxEventEntity,
              { aggregateId: response.walletId },
              { disableIdentityMap: true },
            );
          return rows.every((row) => row.status === 'PUBLISHED');
        },
        15_000,
        100,
      );
    },
    30_000,
  );

  async function fetchWalletCreation(): Promise<{ walletId: string }> {
    const view = await app
      .get(WalletsService)
      .create(
        { playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } },
        `outbox-test-${randomUUID()}`,
      );

    return { walletId: view.id };
  }
});
