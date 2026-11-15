import 'dotenv/config';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { OutboxPublisher } from '../src/messaging/outbox.publisher';

/** Drena a outbox uma vez (diagnóstico manual). */
async function main(): Promise<void> {
  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';

  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const publisher = app.get(OutboxPublisher);
    const published = await publisher.publishPending();
    const lag = await publisher.refreshLagMetrics();
    console.log(`Published ${published} event(s). Pending: ${lag.pending}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
