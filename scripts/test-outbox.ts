import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { OutboxPublisher } from '../src/messaging/outbox.publisher';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const publisher = app.get(OutboxPublisher);
    await publisher.publishPending();
    console.log('Processamento do Outbox finalizado.');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
