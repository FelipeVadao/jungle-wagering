
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';

import { AppModule } from '../app.module';

import { Wallet } from '../wallets/entities/wallet.entity';
import { LedgerEntry } from '../wallets/entities/ledger-entry.entity';

import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../wagering/entities/wager-transaction.entity';

import { OutboxEvent } from './entities/outbox-event.entity';
import { InboxMessage } from './entities/inbox-message.entity';

import { SqsService } from './sqs.service';
import { WagerOperationType } from '../wagering/dto/process-bet.dto';

const CONSUMER_NAME = 'wager-command-consumer';

describe('WagerCommandConsumer (integration)', () => {
  let app: INestApplication;
  let em: EntityManager;
  let sqs: SqsService;

  let wallet: Wallet;
  let providerId: string;
  let externalTransactionId: string;
  let idempotencyKey: string;

  const messageIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    em = moduleRef.get(EntityManager).fork();

    wallet = em.create(Wallet, {
      id: randomUUID(),
      playerId: randomUUID(),
      currency: 'BRL',
      balance: '100.00',
      version: 0,
    });

    providerId = `consumer-provider-${randomUUID()}`;
    externalTransactionId = `external-${randomUUID()}`;
    idempotencyKey = `consumer-key-${randomUUID()}`;

    em.persist(wallet);
    await em.flush();

    app = moduleRef.createNestApplication();

    await app.init();

    sqs = app.get(SqsService);
  }, 60000);

  afterAll(async () => {
    if (em && wallet) {
      const cleanupEm = em.fork();

      const transactions = await cleanupEm.find(
        WagerTransaction,
        { providerId },
      );

      const transactionIds = transactions.map(
        (transaction) => transaction.id,
      );

      if (transactionIds.length > 0) {
        await cleanupEm.nativeDelete(LedgerEntry, {
          wallet: wallet.id,
        });

        await cleanupEm.nativeDelete(OutboxEvent, {
          aggregateId: { $in: transactionIds },
        });

        await cleanupEm.nativeDelete(WagerTransaction, {
          providerId,
        });
      }

      if (messageIds.length > 0) {
        await cleanupEm.nativeDelete(InboxMessage, {
          consumerName: CONSUMER_NAME,
          messageId: { $in: messageIds },
        });
      }

      await cleanupEm.nativeDelete(Wallet, {
        id: wallet.id,
      });
    }

    if (app) {
      await app.close();
    }
  }, 60000);

  it(
    'não deve debitar duas vezes quando recebe mensagens com a mesma chave idempotente',
    async () => {
      const firstEnvelope = {
        messageId: randomUUID(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId,
          externalTransactionId,
          idempotencyKey,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `round-${randomUUID()}`,
          gameId: 'consumer-test-game',
          kind: WagerOperationType.BET,
          money: {
            amount: '30.00',
            currency: 'BRL',
          },
        },
      };

      const secondEnvelope = {
        ...firstEnvelope,
        messageId: randomUUID(),
      };

      const firstMessage = await sqs.publishCommand(
        firstEnvelope,
        wallet.id,
        randomUUID(),
      );

      const secondMessage = await sqs.publishCommand(
        secondEnvelope,
        wallet.id,
        randomUUID(),
      );

      expect(firstMessage.messageId).toBeDefined();
      expect(secondMessage.messageId).toBeDefined();

      messageIds.push(
        firstEnvelope.messageId,
        secondEnvelope.messageId,
      );

      const startedAt = Date.now();
      const timeoutMs = 30000;

      let inboxCount = 0;

      while (Date.now() - startedAt < timeoutMs) {
        const checkEm = em.fork();

        inboxCount = await checkEm.count(InboxMessage, {
          consumerName: CONSUMER_NAME,
          messageId: { $in: messageIds },
        });

        if (inboxCount === 2) {
          break;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, 200),
        );
      }

      expect(inboxCount).toBe(2);

      const checkEm = em.fork();

      const updatedWallet = await checkEm.findOneOrFail(
        Wallet,
        { id: wallet.id },
      );

      const ledgerCount = await checkEm.count(LedgerEntry, {
        wallet: wallet.id,
      });

      const transactionCount = await checkEm.count(
        WagerTransaction,
        {
          providerId,
          externalTransactionId,
        },
      );

      const transaction = await checkEm.findOneOrFail(
        WagerTransaction,
        {
          providerId,
          externalTransactionId,
        },
      );

      expect(updatedWallet.balance).toBe('70.00');
      expect(updatedWallet.version).toBe(1);

      expect(ledgerCount).toBe(1);
      expect(transactionCount).toBe(1);

      expect(transaction.status).toBe(
        WagerTransactionStatus.PROCESSED,
      );
    },
    40000,
  );

  it(
    'não deve duplicar o débito quando o ACK falha após o commit financeiro',
    async () => {
      const retryExternalTransactionId = `external-${randomUUID()}`;
      const retryIdempotencyKey = `retry-key-${randomUUID()}`;

      const envelope = {
        messageId: randomUUID(),
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId,
          externalTransactionId: retryExternalTransactionId,
          idempotencyKey: retryIdempotencyKey,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `round-${randomUUID()}`,
          gameId: 'consumer-test-game',
          kind: WagerOperationType.BET,
          money: {
            amount: '10.00',
            currency: 'BRL',
          },
        },
      };

      let simulatedAckFailure = false;

      const deleteSpy = jest
        .spyOn(sqs, 'deleteCommand')
        .mockImplementationOnce(async () => {
          simulatedAckFailure = true;

          throw new Error(
            'Falha simulada antes da confirmação da mensagem',
          );
        });

      try {
        const publishedMessage = await sqs.publishCommand(
          envelope,
          wallet.id,
          randomUUID(),
        );

        expect(publishedMessage.messageId).toBeDefined();

        messageIds.push(envelope.messageId);

        const startedAt = Date.now();
        const timeoutMs = 70000;

        let inboxCount = 0;

        while (Date.now() - startedAt < timeoutMs) {
          const checkEm = em.fork();

          inboxCount = await checkEm.count(InboxMessage, {
            consumerName: CONSUMER_NAME,
            messageId: envelope.messageId,
          });

          if (
            simulatedAckFailure &&
            deleteSpy.mock.calls.length >= 2 &&
            inboxCount === 1
          ) {
            break;
          }

          await new Promise((resolve) =>
            setTimeout(resolve, 250),
          );
        }

        expect(simulatedAckFailure).toBe(true);
        expect(deleteSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(inboxCount).toBe(1);

        const checkEm = em.fork();

        const updatedWallet = await checkEm.findOneOrFail(
          Wallet,
          { id: wallet.id },
        );

        const ledgerCount = await checkEm.count(LedgerEntry, {
          wallet: wallet.id,
        });

        const transactionCount = await checkEm.count(
          WagerTransaction,
          {
            providerId,
            externalTransactionId: retryExternalTransactionId,
          },
        );

        const transaction = await checkEm.findOneOrFail(
          WagerTransaction,
          {
            providerId,
            externalTransactionId: retryExternalTransactionId,
          },
        );

        expect(updatedWallet.balance).toBe('60.00');
        expect(updatedWallet.version).toBe(2);

        expect(ledgerCount).toBe(2);
        expect(transactionCount).toBe(1);

        expect(transaction.status).toBe(
          WagerTransactionStatus.PROCESSED,
        );
      } finally {
        deleteSpy.mockRestore();
      }
    },
    75000,
  );
});
