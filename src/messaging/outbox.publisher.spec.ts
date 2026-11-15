
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';

import { AppModule } from '../app.module';

import { OutboxEvent } from './entities/outbox-event.entity';
import { OutboxPublisher } from './outbox.publisher';
import { SqsService } from './sqs.service';

describe('OutboxPublisher (integration)', () => {
  let app: INestApplication;
  let em: EntityManager;
  let sqs: SqsService;

  let eventId: string;
  let firstPublisher: OutboxPublisher;
  let secondPublisher: OutboxPublisher;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    await app.init();

    em = app.get(EntityManager).fork();
    sqs = app.get(SqsService);

    firstPublisher = new OutboxPublisher(em.fork(), sqs);
    secondPublisher = new OutboxPublisher(em.fork(), sqs);
  }, 60000);

  afterAll(async () => {
    if (em && eventId) {
      await em.nativeDelete(OutboxEvent, {
        id: eventId,
      });
    }

    if (app) {
      await app.close();
    }
  }, 60000);

  it(
    'não deve publicar o mesmo evento quando dois publicadores executam simultaneamente',
    async () => {
      eventId = randomUUID();

      const aggregateId = randomUUID();

      const event = em.create(OutboxEvent, {
        id: eventId,
        eventType: 'WagerTransactionProcessed',
        aggregateId,
        payload: {
          eventId,
          aggregateId,
          test: 'outbox-concurrency',
        },
        status: 'PENDING',
        attempts: 0,
        createdAt: new Date('2000-01-01T00:00:00.000Z'),
      });

      em.persist(event);
      await em.flush();

      let releasePublish!: () => void;
      let notifyPublishEntered!: () => void;

      const publishGate = new Promise<void>((resolve) => {
        releasePublish = resolve;
      });

      const publishEntered = new Promise<void>((resolve) => {
        notifyPublishEntered = resolve;
      });

      const originalPublishEvent = sqs.publishEvent.bind(sqs);

      const publishSpy = jest
        .spyOn(sqs, 'publishEvent')
        .mockImplementation(
          async (payload, messageGroupId, publishedEventId) => {
            notifyPublishEntered();

            await publishGate;

            return originalPublishEvent(
              payload,
              messageGroupId,
              publishedEventId,
            );
          },
        );

      const countTargetEventCalls = () =>
        publishSpy.mock.calls.filter(
          (([, , publishedEventId]) => publishedEventId === eventId),
        ).length;

      let firstExecution: Promise<void> | undefined;
      let secondExecution: Promise<void> | undefined;

      try {
        firstExecution = firstPublisher.publishPending();

        await Promise.race([
          publishEntered,
          firstExecution.then(() => {
            throw new Error(
              'O primeiro publicador terminou sem chegar ao envio do SQS.',
            );
          }),
        ]);

        secondExecution = secondPublisher.publishPending();

        const secondResult = await Promise.race([
          secondExecution.then(() => 'completed'),
          new Promise<'timeout'>((resolve) => {
            setTimeout(() => resolve('timeout'), 5000);
          }),
        ]);

        expect(secondResult).toBe('completed');
        expect(countTargetEventCalls()).toBe(1);

        releasePublish();

        await firstExecution;

        expect(countTargetEventCalls()).toBe(1);

        const checkEm = em.fork();

        const updatedEvent = await checkEm.findOneOrFail(
          OutboxEvent,
          { id: eventId },
        );

        expect(updatedEvent.status).toBe('PUBLISHED');
        expect(updatedEvent.attempts).toBe(0);
        expect(updatedEvent.publishedAt).toBeInstanceOf(Date);
        expect(updatedEvent.lastError == null).toBe(true);
      } finally {
        releasePublish();

        if (firstExecution) {
          await firstExecution.catch(() => undefined);
        }

        if (secondExecution) {
          await secondExecution.catch(() => undefined);
        }

        publishSpy.mockRestore();
      }
    },
    30000,
  );
});
