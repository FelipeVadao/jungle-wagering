
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { EntityManager } from '@mikro-orm/postgresql';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { Message } from '@aws-sdk/client-sqs';

import { WageringService } from '../wagering/wagering.service';
import { ProcessBetDto } from '../wagering/dto/process-bet.dto';

import { InboxMessage } from './entities/inbox-message.entity';
import { SqsService } from './sqs.service';

const CONSUMER_NAME = 'wager-command-consumer';
const EXPECTED_MESSAGE_TYPE = 'WagerTransactionRequested';

interface WagerCommandEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: ProcessBetDto;
  idempotencyKey: string;
}

@Injectable()
export class WagerCommandConsumer
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WagerCommandConsumer.name);

  private running = false;
  private polling?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
    private readonly wageringService: WageringService,
  ) {}

  onModuleInit(): void {
    this.running = true;
    this.polling = this.consumeLoop();

    this.logger.log('Wager Command Consumer iniciado');
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;

    if (this.polling) {
      await this.polling;
    }

    this.logger.log('Wager Command Consumer encerrado');
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.sqs.receiveCommands(10, 20);

        for (const message of messages) {
          if (!this.running) {
            break;
          }

          await this.handleMessage(message);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        this.logger.error(
          `Erro no loop do Consumer: ${errorMessage}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    const sqsMessageId = message.MessageId;
    const receiptHandle = message.ReceiptHandle;

    if (!sqsMessageId || !receiptHandle || !message.Body) {
      this.logger.error(
        'Mensagem SQS recebida sem MessageId, ReceiptHandle ou Body',
      );
      return;
    }

    try {
      const envelope = await this.parseEnvelope(message.Body);

      await this.processAtomically(envelope);

      // ACK somente depois do commit no PostgreSQL.
      await this.sqs.deleteCommand(receiptHandle);

      this.logger.log(
        `Mensagem ${envelope.messageId} processada e confirmada`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Falha ao processar mensagem SQS ${sqsMessageId}: ${errorMessage}`,
      );

      // Sem ACK: o SQS poderá entregar a mensagem novamente.
    }
  }

  private async parseEnvelope(
    body: string,
  ): Promise<WagerCommandEnvelope> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('Mensagem contém JSON inválido');
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('Formato inválido para mensagem de comando');
    }

    const envelope = parsed as Record<string, unknown>;

    if (
      typeof envelope.messageId !== 'string' ||
      envelope.messageId.trim().length === 0 ||
      envelope.messageId.length > 255
    ) {
      throw new Error('messageId inválido');
    }

    if (envelope.type !== EXPECTED_MESSAGE_TYPE) {
      throw new Error('Tipo de mensagem não suportado');
    }

    if (
      typeof envelope.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(envelope.occurredAt))
    ) {
      throw new Error('occurredAt inválido');
    }

    if (
      typeof envelope.data !== 'object' ||
      envelope.data === null ||
      Array.isArray(envelope.data)
    ) {
      throw new Error('Campo data inválido');
    }

    const data = envelope.data as Record<string, unknown>;

    if (
      typeof data.idempotencyKey !== 'string' ||
      data.idempotencyKey.trim().length === 0 ||
      data.idempotencyKey.length > 255
    ) {
      throw new Error('Idempotency-Key inválida');
    }

    // A chave de idempotência pertence ao envelope,
    // não ao DTO da operação financeira.
    const { idempotencyKey, ...operationData } = data;

    const dto = plainToInstance(ProcessBetDto, operationData);

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {
      const details = errors
        .map((error) =>
          Object.values(error.constraints ?? {}).join(', '),
        )
        .filter(Boolean)
        .join('; ');

      throw new Error(
        `Dados da operação inválidos: ${details}`,
      );
    }

    return {
      messageId: envelope.messageId.trim(),
      type: EXPECTED_MESSAGE_TYPE,
      occurredAt: envelope.occurredAt,
      data: dto,
      idempotencyKey: idempotencyKey.trim(),
    };
  }

  private async processAtomically(
    envelope: WagerCommandEnvelope,
  ): Promise<void> {
    try {
      await this.em.transactional(async (tx) => {
        const existing = await tx.findOne(InboxMessage, {
          consumerName: CONSUMER_NAME,
          messageId: envelope.messageId,
        });

        if (existing) {
          this.logger.warn(
            `Mensagem ${envelope.messageId} já registrada na Inbox`,
          );
          return;
        }

        const inboxMessage = tx.create(InboxMessage, {
          id: randomUUID(),
          consumerName: CONSUMER_NAME,
          messageId: envelope.messageId,
          processedAt: new Date(),
        });

        tx.persist(inboxMessage);

        // Inbox e operação financeira pertencem à mesma transação.
        await tx.flush();

        await this.wageringService.processBetInTransaction(
          tx,
          envelope.data,
          envelope.idempotencyKey,
        );
      });
    } catch (error) {
      const existing = await this.em
        .fork()
        .findOne(InboxMessage, {
          consumerName: CONSUMER_NAME,
          messageId: envelope.messageId,
        });

      if (existing) {
        this.logger.warn(
          `Mensagem ${envelope.messageId} já foi confirmada por outro processamento`,
        );
        return;
      }

      throw error;
    }
  }
}
