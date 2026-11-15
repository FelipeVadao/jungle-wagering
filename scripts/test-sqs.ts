import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { SqsService } from '../src/messaging/sqs.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const sqs = app.get(SqsService);

    const idempotencyKey = randomUUID();

    const result = await sqs.publishCommand(
      {
        idempotencyKey,
        data: {
          walletId: '00000000-0000-4000-8000-000000000001',
          providerId: 'test-provider',
          externalTransactionId: randomUUID(),
          type: 'BET',
          amount: '50.00',
        },
      },
      'test-wallet-001',
      idempotencyKey,
    );

    console.log('Comando publicado:', result);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Erro ao publicar:', error);
  process.exitCode = 1;
});
