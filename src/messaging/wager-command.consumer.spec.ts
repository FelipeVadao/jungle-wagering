import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';

import {
  countRows,
  createTestApp,
  createWallet,
  expectLedgerConsistent,
  TestWallet,
  transactionsOf,
  walletState,
} from '../../test/support/app';
import { takeMessage } from '../../test/support/sqs';
import { WageringService } from '../wagering/wagering.service';

import { SqsService } from './sqs.service';
import { CONSUMER_NAME, ConsumerOutcome, WagerCommandConsumer } from './wager-command.consumer';

const providerId = `consumer-provider-${randomUUID()}`;

interface CommandEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  };
}

function command(
  wallet: TestWallet,
  amount: string,
  overrides: Partial<CommandEnvelope['data']> = {},
): CommandEnvelope {
  const externalTransactionId = `external-${randomUUID()}`;

  return {
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId,
      externalTransactionId,
      idempotencyKey: `${providerId}:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'consumer-test-game',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
      ...overrides,
    },
  };
}

function messageIdOf(body: string | undefined): string {
  try {
    const { messageId } = JSON.parse(body ?? '{}') as { messageId?: unknown };
    return typeof messageId === 'string' ? messageId : '';
  } catch {
    return '';
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('WagerCommandConsumer (integration)', () => {
  let app: INestApplication;
  let sqs: SqsService;
  let consumer: WagerCommandConsumer;
  let wagering: WageringService;

  const send = (envelope: unknown, groupId: string) =>
    sqs.publishCommand(envelope, groupId, randomUUID());

  const inboxCount = (messageIds: string[]) =>
    countRows(
      app,
      `select 1 from "inbox_messages"
        where "consumer_name" = ?
          and "message_id" in (${messageIds.map(() => '?').join(', ')})`,
      [CONSUMER_NAME, ...messageIds],
    );

  /**
   * Roda o consumer (receive + handleMessage, como o loop do worker) até a
   * condição ser satisfeita. Só devolve os resultados das mensagens do
   * próprio teste (`messageIds`), para que sobras de outro teste não
   * interfiram nas asserções.
   */
  async function consumeUntil(
    messageIds: string[],
    condition: (outcomes: ConsumerOutcome[]) => Promise<boolean> | boolean,
    timeoutMs = 30_000,
  ): Promise<ConsumerOutcome[]> {
    const outcomes: ConsumerOutcome[] = [];
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const messages = await sqs.receiveCommands({
        maxMessages: 10,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: Number(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 2),
      });

      for (const message of messages) {
        const outcome = await consumer.handleMessage(message);

        if (messageIds.includes(messageIdOf(message.Body))) {
          outcomes.push(outcome);
        }
      }

      if (await condition(outcomes)) {
        return outcomes;
      }
    }

    throw new Error(`Consumer condition not met in ${timeoutMs}ms: ${JSON.stringify(outcomes)}`);
  }

  beforeAll(async () => {
    app = await createTestApp();
    sqs = app.get(SqsService);
    consumer = app.get(WagerCommandConsumer);
    wagering = app.get(WageringService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 60_000);

  it(
    'não deve debitar duas vezes quando recebe mensagens com a mesma chave idempotente',
    async () => {
      const wallet = await createWallet(app, '100.00');
      const firstEnvelope = command(wallet, '30.00');
      const secondEnvelope = { ...firstEnvelope, messageId: randomUUID() };

      expect((await send(firstEnvelope, wallet.id)).messageId).toBeDefined();
      expect((await send(secondEnvelope, wallet.id)).messageId).toBeDefined();

      const messageIds = [firstEnvelope.messageId, secondEnvelope.messageId];
      const outcomes = await consumeUntil(messageIds, async () => (await inboxCount(messageIds)) === 2);

      const processed = outcomes.filter((outcome) => outcome.kind === 'processed');
      expect(processed).toHaveLength(2);
      expect(
        processed.map((outcome) => outcome.kind === 'processed' && outcome.result.idempotentReplay),
      ).toEqual([false, true]);

      const transactions = await transactionsOf(
        app,
        providerId,
        firstEnvelope.data.externalTransactionId,
      );

      expect(transactions).toHaveLength(1);
      expect(transactions[0].status).toBe('PROCESSED');
      // OPENING (version 1, crédito de abertura) + 1 único débito.
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '70.00',
        version: 2,
        ledgerEntries: 2,
        debits: 1,
      });
      await expectLedgerConsistent(app, wallet.id);
    },
    40_000,
  );

  it(
    'não deve duplicar o débito quando o ACK falha após o commit financeiro',
    async () => {
      const wallet = await createWallet(app, '100.00');
      const envelope = command(wallet, '10.00');
      let simulatedAckFailure = false;

      const deleteSpy = jest.spyOn(sqs, 'deleteCommand').mockImplementationOnce(async () => {
        simulatedAckFailure = true;
        throw new Error('Falha simulada antes da confirmação da mensagem');
      });

      try {
        expect((await send(envelope, wallet.id)).messageId).toBeDefined();

        const outcomes = await consumeUntil(
          [envelope.messageId],
          async () =>
            simulatedAckFailure &&
            deleteSpy.mock.calls.length >= 2 &&
            (await inboxCount([envelope.messageId])) === 1,
        );

        expect(simulatedAckFailure).toBe(true);
        expect(deleteSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        // 1ª entrega: processada (commit) + ACK falhou; 2ª: duplicata na inbox.
        expect(outcomes.map((outcome) => outcome.kind)).toEqual(['processed', 'duplicate']);
        expect(await inboxCount([envelope.messageId])).toBe(1);

        const transactions = await transactionsOf(
          app,
          providerId,
          envelope.data.externalTransactionId,
        );

        expect(transactions).toHaveLength(1);
        expect(transactions[0].status).toBe('PROCESSED');
        expect(await walletState(app, wallet.id)).toMatchObject({
          balance: '90.00',
          version: 2,
          ledgerEntries: 2,
          debits: 1,
        });

        // A redelivery foi confirmada: a mensagem não volta mais.
        expect(
          await takeMessage(
            sqs.commandQueueUrl,
            (body) => body.messageId === envelope.messageId,
            4000,
          ),
        ).toBeUndefined();
        await expectLedgerConsistent(app, wallet.id);
      } finally {
        deleteSpy.mockRestore();
      }
    },
    60_000,
  );

  it(
    'mensagem inválida é falha permanente: vai para a DLQ com o motivo e sem efeito financeiro',
    async () => {
      const wallet = await createWallet(app, '100.00');
      const envelope = command(wallet, '25.50');
      // amount como number: viola o contrato de dinheiro (string decimal).
      (envelope.data.money as { amount: unknown }).amount = 25.5;

      await send(envelope, wallet.id);

      const outcomes = await consumeUntil([envelope.messageId], (all) =>
        all.some((outcome) => outcome.kind === 'dead-lettered'),
      );

      expect(outcomes).toEqual([{ kind: 'dead-lettered', reason: 'INVALID_MESSAGE' }]);

      const dead = await takeMessage(
        sqs.commandDlqUrl,
        (body) => body.messageId === envelope.messageId,
      );

      expect(dead?.MessageAttributes?.failureReason?.StringValue).toBe('INVALID_MESSAGE');
      expect(await inboxCount([envelope.messageId])).toBe(0);
      expect(
        await transactionsOf(app, providerId, envelope.data.externalTransactionId),
      ).toHaveLength(0);
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '100.00',
        version: 1,
        ledgerEntries: 1,
      });
    },
    40_000,
  );

  it(
    'rejeição de negócio é terminal: persiste REJECTED e confirma (ack) sem ir para a DLQ',
    async () => {
      const wallet = await createWallet(app, '100.00');
      const envelope = command(wallet, '150.00');

      await send(envelope, wallet.id);

      const outcomes = await consumeUntil([envelope.messageId], (all) => all.length > 0);

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].kind).toBe('processed');

      const transactions = await transactionsOf(
        app,
        providerId,
        envelope.data.externalTransactionId,
      );

      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
      });
      expect(await inboxCount([envelope.messageId])).toBe(1);
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '100.00',
        version: 1,
        ledgerEntries: 1,
      });
      expect(
        await takeMessage(
          sqs.commandDlqUrl,
          (body) => body.messageId === envelope.messageId,
          2000,
        ),
      ).toBeUndefined();
    },
    40_000,
  );

  it(
    'falha transitória desfaz inbox, transação, ledger, saldo e outbox juntos; a redelivery processa uma única vez',
    async () => {
      const wallet = await createWallet(app, '100.00');
      const envelope = command(wallet, '40.00');
      const originalSubmit = wagering.submitInTransaction.bind(wagering);
      let injectedFailures = 0;

      // Falha DEPOIS de o use case ter escrito tudo na transação (flush).
      const submitSpy = jest
        .spyOn(wagering, 'submitInTransaction')
        .mockImplementation(async (tx, cmd, ctx) => {
          const result = await originalSubmit(tx, cmd, ctx);

          if (injectedFailures === 0) {
            injectedFailures += 1;
            throw Object.assign(new Error('conexão perdida antes do commit (simulado)'), {
              code: 'ECONNRESET',
            });
          }

          return result;
        });

      const outboxOfWallet = () =>
        countRows(app, `select 1 from "outbox_events" where "aggregate_id" = ?`, [wallet.id]);

      try {
        await send(envelope, wallet.id);

        const first = await consumeUntil([envelope.messageId], (all) => all.length > 0);

        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ kind: 'retry-scheduled', reason: 'TRANSIENT_FAILURE' });

        // Nada do processamento sobreviveu ao rollback.
        expect(await inboxCount([envelope.messageId])).toBe(0);
        expect(
          await transactionsOf(app, providerId, envelope.data.externalTransactionId),
        ).toHaveLength(0);
        expect(await walletState(app, wallet.id)).toMatchObject({
          balance: '100.00',
          version: 1,
          ledgerEntries: 1,
        });
        expect(await outboxOfWallet()).toBe(1); // só o WalletBalanceChanged da abertura

        const retried = await consumeUntil([envelope.messageId], (all) =>
          all.some((outcome) => outcome.kind === 'processed'),
        );

        expect(retried.map((outcome) => outcome.kind)).toEqual(['processed']);
        expect(submitSpy.mock.calls.length).toBe(2);
        expect(await inboxCount([envelope.messageId])).toBe(1);
        expect(await walletState(app, wallet.id)).toMatchObject({
          balance: '60.00',
          version: 2,
          ledgerEntries: 2,
          debits: 1,
        });
        expect(await outboxOfWallet()).toBe(2);
        await expectLedgerConsistent(app, wallet.id);
      } finally {
        submitSpy.mockRestore();
      }
    },
    40_000,
  );

  it(
    'esgotado o limite de tentativas, a mensagem vai para a DLQ (MAX_RECEIVE_COUNT_EXCEEDED)',
    async () => {
      const wallet = await createWallet(app, '100.00');
      const envelope = command(wallet, '5.00');
      const submitSpy = jest
        .spyOn(wagering, 'submitInTransaction')
        .mockImplementation(async () => {
          throw Object.assign(new Error('PostgreSQL indisponível (simulado)'), {
            code: 'ECONNREFUSED',
          });
        });

      try {
        await send(envelope, wallet.id);

        const outcomes = await consumeUntil(
          [envelope.messageId],
          (all) => all.some((outcome) => outcome.kind === 'dead-lettered'),
          45_000,
        );

        // SQS_MAX_RECEIVE_COUNT=3 nos testes; backoff 1s, 2s.
        expect(outcomes).toEqual([
          { kind: 'retry-scheduled', delaySeconds: 1, reason: 'TRANSIENT_FAILURE' },
          { kind: 'retry-scheduled', delaySeconds: 2, reason: 'TRANSIENT_FAILURE' },
          { kind: 'dead-lettered', reason: 'MAX_RECEIVE_COUNT_EXCEEDED' },
        ]);

        const dead = await takeMessage(
          sqs.commandDlqUrl,
          (body) => body.messageId === envelope.messageId,
        );

        expect(dead?.MessageAttributes?.failureReason?.StringValue).toBe(
          'MAX_RECEIVE_COUNT_EXCEEDED',
        );
        expect(dead?.MessageAttributes?.receiveCount?.StringValue).toBe('3');
        expect(await inboxCount([envelope.messageId])).toBe(0);
        expect(await walletState(app, wallet.id)).toMatchObject({
          balance: '100.00',
          version: 1,
        });
      } finally {
        submitSpy.mockRestore();
      }
    },
    60_000,
  );

  it(
    'mesmo messageId com payload diferente é conflito permanente (DLQ), sem novo efeito',
    async () => {
      const wallet = await createWallet(app, '100.00');
      const original = command(wallet, '10.00');
      const tampered = command(wallet, '99.00');
      tampered.messageId = original.messageId;

      await send(original, wallet.id);
      await consumeUntil([original.messageId], (all) =>
        all.some((outcome) => outcome.kind === 'processed'),
      );

      await send(tampered, wallet.id);
      const outcomes = await consumeUntil([tampered.messageId], (all) => all.length > 0);

      expect(outcomes).toEqual([{ kind: 'dead-lettered', reason: 'INBOX_PAYLOAD_CONFLICT' }]);
      expect(
        await transactionsOf(app, providerId, tampered.data.externalTransactionId),
      ).toHaveLength(0);
      expect(await walletState(app, wallet.id)).toMatchObject({
        balance: '90.00',
        version: 2,
      });
      expect(
        await takeMessage(sqs.commandDlqUrl, (body) => body.messageId === original.messageId),
      ).toBeDefined();
    },
    40_000,
  );

  it(
    'stop() (SIGTERM): conclui a mensagem em andamento, não busca novas e devolve as demais',
    async () => {
      const wallet = await createWallet(app, '100.00');
      const inFlight = command(wallet, '10.00');
      const queued = command(wallet, '20.00');
      const gate = deferred();
      const entered = deferred();
      const originalSubmit = wagering.submitInTransaction.bind(wagering);

      const submitSpy = jest
        .spyOn(wagering, 'submitInTransaction')
        .mockImplementation(async (tx, cmd, ctx) => {
          if (cmd.externalTransactionId === inFlight.data.externalTransactionId) {
            entered.resolve();
            await gate.promise;
          }

          return originalSubmit(tx, cmd, ctx);
        });
      const deleteSpy = jest.spyOn(sqs, 'deleteCommand');

      try {
        await send(inFlight, wallet.id);
        await send(queued, wallet.id);

        consumer.start();
        await Promise.race([
          entered.promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('consumer não recebeu a mensagem')), 15_000),
          ),
        ]);

        const stopping = consumer.stop();
        gate.resolve();
        await stopping;

        // A mensagem em andamento terminou e foi confirmada; a outra não foi tocada.
        expect(
          (await transactionsOf(app, providerId, inFlight.data.externalTransactionId))[0]?.status,
        ).toBe('PROCESSED');
        expect(deleteSpy).toHaveBeenCalled();
        expect(await inboxCount([inFlight.messageId])).toBe(1);
        expect(
          await transactionsOf(app, providerId, queued.data.externalTransactionId),
        ).toHaveLength(0);
        expect(await walletState(app, wallet.id)).toMatchObject({ balance: '90.00', version: 2 });

        // Outra instância assume a mensagem devolvida.
        await consumeUntil(
          [queued.messageId],
          async () =>
            (await transactionsOf(app, providerId, queued.data.externalTransactionId)).length ===
            1,
        );

        expect(await walletState(app, wallet.id)).toMatchObject({
          balance: '70.00',
          version: 3,
          ledgerEntries: 3,
          debits: 2,
        });
        // A mensagem concluída durante o stop() foi confirmada: não reaparece.
        expect(
          await takeMessage(
            sqs.commandQueueUrl,
            (body) => body.messageId === inFlight.messageId,
            3000,
          ),
        ).toBeUndefined();
        await expectLedgerConsistent(app, wallet.id);
      } finally {
        gate.resolve();
        await consumer.stop();
        submitSpy.mockRestore();
        deleteSpy.mockRestore();
      }
    },
    60_000,
  );
});
