import 'reflect-metadata';

import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // Logs estruturados (JSON) por padrão; LOG_FORMAT=pretty para desenvolvimento.
  const logger = new ConsoleLogger({
    json: process.env.LOG_FORMAT !== 'pretty',
    colors: process.env.LOG_FORMAT === 'pretty',
  });

  const app = await NestFactory.create(AppModule, { logger });

  // SIGTERM/SIGINT disparam onModuleDestroy: o consumer conclui a mensagem em
  // andamento e devolve a visibilidade das demais; workers param no fim do tick.
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
