import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { SqsService } from '../src/messaging/sqs.service';

/**
 * Publica um `WagerTransactionRequested` na fila de entrada.
 * Uso: bun scripts/test-sqs.ts <walletId> <playerId> [amount]
 */
async function main(): Promise<void> {
  const [walletId, playerId, amount = '10.00'] = process.argv.slice(2);

  if (!walletId || !playerId) {
    throw new Error('Usage: bun scripts/test-sqs.ts <walletId> <playerId> [amount]');
  }

  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';

  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const sqs = app.get(SqsService);
    const externalTransactionId = `script-${randomUUID()}`;
    const envelope = {
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'script-provider',
        externalTransactionId,
        idempotencyKey: `script-provider:${externalTransactionId}`,
        playerId,
        walletId,
        roundId: `round-${randomUUID()}`,
        gameId: 'script-game',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      },
    };

    const result = await sqs.publishCommand(envelope, walletId, envelope.messageId);
    console.log('Command published:', result, envelope.messageId);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Failed to publish:', error);
  process.exitCode = 1;
});
