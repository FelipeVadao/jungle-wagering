/**
 * Processo auxiliar dos testes: consome a fila de comandos e MORRE
 * abruptamente (exit 137, sem cleanup) no instante do ACK da mensagem alvo —
 * isto é, depois do commit e antes do ack. Uso:
 *   bun test/support/crash-consumer.ts <messageId>
 */
import 'reflect-metadata';

import { Message } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../src/app.module';
import { SqsService } from '../../src/messaging/sqs.service';
import { WagerCommandConsumer } from '../../src/messaging/wager-command.consumer';

async function main(): Promise<void> {
  const targetMessageId = process.argv[2];

  if (!targetMessageId) {
    throw new Error('usage: crash-consumer.ts <messageId>');
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const sqs = app.get(SqsService);
  const consumer = app.get(WagerCommandConsumer);
  const receive = sqs.receiveCommands.bind(sqs);
  const remove = sqs.deleteCommand.bind(sqs);
  const targetReceipts = new Set<string>();

  // Só a mensagem alvo é processada aqui; outras voltam para a fila na hora.
  sqs.receiveCommands = async (options) => {
    const messages: Message[] = await receive(options);
    const mine: Message[] = [];

    for (const message of messages) {
      const body = JSON.parse(message.Body ?? '{}') as { messageId?: string };

      if (body.messageId === targetMessageId && message.ReceiptHandle) {
        targetReceipts.add(message.ReceiptHandle);
        mine.push(message);
      } else if (message.ReceiptHandle) {
        await sqs.changeCommandVisibility(message.ReceiptHandle, 0);
      }
    }

    return mine;
  };

  sqs.deleteCommand = async (receiptHandle: string) => {
    if (targetReceipts.has(receiptHandle)) {
      // Commit já aconteceu; o processo morre antes de confirmar a mensagem.
      process.exit(137);
    }

    return remove(receiptHandle);
  };

  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    await consumer.pollOnce(1);
  }

  process.exit(2);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(3);
});
