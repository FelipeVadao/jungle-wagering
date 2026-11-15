import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { Message } from '@aws-sdk/client-sqs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { DomainError } from '../common/domain/domain-error';
import {
  InboxPayloadConflictError,
  InvalidMessageError,
} from '../common/errors/application-errors';
import { MetricsService } from '../observability/metrics.service';
import { canonicalJson, sha256Hex } from '../wagering/domain/payload-hash';
import { WagerTransactionRequestedDataDto } from '../wagering/dto/process-bet.dto';
import {
  positiveInt,
  SubmitWagerCommand,
  WageringService,
  WagerSubmissionResult,
} from '../wagering/wagering.service';

import { InboxMessage } from './domain/inbox-message';
import { InboxMessageEntity } from './entities/inbox-message.entity';
import { SqsService } from './sqs.service';

export const CONSUMER_NAME = 'wager-command-consumer';
export const EXPECTED_MESSAGE_TYPE = 'WagerTransactionRequested';

interface WagerCommandEnvelope {
  messageId: string;
  type: typeof EXPECTED_MESSAGE_TYPE;
  occurredAt: string;
  correlationId?: string;
  command: SubmitWagerCommand;
  payloadHash: string;
}

export type ConsumerOutcome =
  | { kind: 'processed'; result: WagerSubmissionResult }
  | { kind: 'duplicate' }
  | { kind: 'retry-scheduled'; delaySeconds: number; reason: string }
  | { kind: 'dead-lettered'; reason: string };

/**
 * Consumer de `WagerTransactionRequested` (wager-transactions.fifo).
 *
 * - reutiliza o mesmo use case da entrada HTTP (WageringService);
 * - inbox persistente por (consumerName, messageId) na MESMA transação SQL;
 * - ack somente após o commit;
 * - negócio (PROCESSED/REJECTED/PENDING_REFERENCE registrados) → ack;
 *   transitório → nova tentativa com backoff (ChangeMessageVisibility);
 *   permanente (mensagem inválida/conflito/sem wallet) ou tentativas
 *   esgotadas → DLQ explícita;
 * - SIGTERM: termina a mensagem em andamento e devolve a visibilidade das
 *   demais do lote.
 */
@Injectable()
export class WagerCommandConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WagerCommandConsumer.name);
  private readonly maxReceiveCount: number;
  private readonly visibilityTimeoutSeconds: number;
  private readonly waitTimeSeconds: number;
  private readonly retryBaseDelaySeconds: number;

  private running = false;
  private loop?: Promise<void>;
  private abortController = new AbortController();

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
    private readonly wagering: WageringService,
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {
    this.maxReceiveCount = positiveInt(config.get('SQS_MAX_RECEIVE_COUNT'), 5);
    this.visibilityTimeoutSeconds = positiveInt(
      config.get('SQS_VISIBILITY_TIMEOUT_SECONDS'),
      30,
    );
    this.waitTimeSeconds = Math.min(
      positiveInt(config.get('SQS_WAIT_TIME_SECONDS'), 20),
      20,
    );
    this.retryBaseDelaySeconds = positiveInt(
      config.get('SQS_RETRY_BASE_DELAY_SECONDS'),
      2,
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.get('SQS_CONSUMER_ENABLED', 'true') !== 'false') {
      this.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    this.loop = this.consumeLoop();
    this.logger.log({ msg: 'consumer.started', consumer: CONSUMER_NAME });
  }

  /** Para de buscar, conclui a mensagem em andamento e devolve as demais. */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.abortController.abort();
    await this.loop;
    this.logger.log({ msg: 'consumer.stopped', consumer: CONSUMER_NAME });
  }

  /** Uma rodada de recebimento + processamento (útil em testes). */
  async pollOnce(waitTimeSeconds = this.waitTimeSeconds): Promise<ConsumerOutcome[]> {
    const messages = await this.sqs.receiveCommands({
      maxMessages: 10,
      waitTimeSeconds,
      visibilityTimeoutSeconds: this.visibilityTimeoutSeconds,
    });

    const outcomes: ConsumerOutcome[] = [];

    for (const message of messages) {
      outcomes.push(await this.handleMessage(message));
    }

    return outcomes;
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      let messages: Message[];

      try {
        messages = await this.sqs.receiveCommands({
          maxMessages: 10,
          waitTimeSeconds: this.waitTimeSeconds,
          visibilityTimeoutSeconds: this.visibilityTimeoutSeconds,
          abortSignal: this.abortController.signal,
        });
      } catch (error) {
        if (!this.running) {
          break;
        }

        this.logger.error({
          msg: 'consumer.receive_failed',
          error: errorMessage(error),
        });
        await sleep(1000);
        continue;
      }

      for (let index = 0; index < messages.length; index += 1) {
        if (!this.running) {
          await this.releaseUnprocessed(messages.slice(index));
          break;
        }

        await this.handleMessage(messages[index]);
      }
    }
  }

  async handleMessage(message: Message): Promise<ConsumerOutcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let envelope: WagerCommandEnvelope | undefined;
    let outcome: ConsumerOutcome;

    try {
      envelope = await this.parseEnvelope(message);
      outcome = await this.processAtomically(envelope);
    } catch (error) {
      return this.handleFailure(message, error, receiveCount, envelope);
    }

    // ACK somente depois do commit. Se o ACK falhar, a redelivery cai na
    // inbox como duplicata e é confirmada sem novo efeito financeiro.
    try {
      await this.sqs.deleteCommand(message.ReceiptHandle ?? '');
    } catch (error) {
      this.logger.warn({
        msg: 'consumer.ack_failed_after_commit',
        messageId: envelope.messageId,
        sqsMessageId: message.MessageId,
        correlationId: envelope.correlationId ?? envelope.messageId,
        error: errorMessage(error),
      });
    }

    if (outcome.kind === 'processed') {
      const transaction = outcome.result.transaction;
      this.logger.log({
        msg: 'consumer.message_processed',
        messageId: envelope.messageId,
        correlationId: envelope.correlationId ?? envelope.messageId,
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        status: transaction.status,
        idempotentReplay: outcome.result.idempotentReplay,
      });
    }

    return outcome;
  }

  private async processAtomically(
    envelope: WagerCommandEnvelope,
  ): Promise<ConsumerOutcome> {
    return this.em.fork().transactional(async (tx) => {
      const inbox = InboxMessage.receive({
        messageId: envelope.messageId,
        consumerName: CONSUMER_NAME,
        payloadHash: envelope.payloadHash,
        receivedAt: new Date(),
      });
      inbox.markProcessed(inbox.receivedAt);

      // ON CONFLICT DO NOTHING: duas instâncias com a mesma mensagem se
      // serializam no índice único; a segunda vê a primeira já confirmada.
      const inserted = await tx.execute<Array<{ id: string }>>(
        `insert into "inbox_messages"
           ("id", "consumer_name", "message_id", "payload_hash", "received_at", "processed_at")
         values (?, ?, ?, ?, ?, ?)
         on conflict ("consumer_name", "message_id") do nothing
         returning "id"`,
        [
          randomUUID(),
          inbox.consumerName,
          inbox.messageId,
          inbox.payloadHash,
          inbox.receivedAt,
          inbox.processedAt ?? inbox.receivedAt,
        ],
      );

      if (inserted.length === 0) {
        const existing = await tx.findOneOrFail(
          InboxMessageEntity,
          { consumerName: CONSUMER_NAME, messageId: envelope.messageId },
          { disableIdentityMap: true },
        );

        if (existing.payloadHash && existing.payloadHash !== envelope.payloadHash) {
          this.metrics.increment('idempotency_conflicts_total', {
            channel: 'sqs',
            source: 'inbox',
          });
          throw new InboxPayloadConflictError(
            `messageId ${envelope.messageId} already received with a different payload`,
          );
        }

        this.metrics.increment('idempotency_duplicates_total', {
          channel: 'sqs',
          source: 'inbox',
        });

        return { kind: 'duplicate' } as const;
      }

      const result = await this.wagering.submitInTransaction(tx, envelope.command, {
        channel: 'sqs',
        correlationId: envelope.correlationId ?? envelope.messageId,
        causationId: envelope.messageId,
      });

      return { kind: 'processed', result } as const;
    });
  }

  private async handleFailure(
    message: Message,
    error: unknown,
    receiveCount: number,
    envelope: WagerCommandEnvelope | undefined,
  ): Promise<ConsumerOutcome> {
    const permanent = isPermanentFailure(error);
    const reason = permanent
      ? failureCodeOf(error)
      : receiveCount >= this.maxReceiveCount
        ? 'MAX_RECEIVE_COUNT_EXCEEDED'
        : 'TRANSIENT_FAILURE';
    const logContext = {
      messageId: envelope?.messageId,
      sqsMessageId: message.MessageId,
      correlationId: envelope?.correlationId ?? envelope?.messageId,
      walletId: envelope?.command.walletId,
      providerId: envelope?.command.providerId,
      receiveCount,
      reason,
      error: errorMessage(error),
    };

    if (permanent || receiveCount >= this.maxReceiveCount) {
      try {
        await this.sqs.sendToDeadLetterQueue(message, reason, errorMessage(error));
        await this.sqs.deleteCommand(message.ReceiptHandle ?? '');
        this.metrics.increment('sqs_messages_dead_lettered_total', { reason });
        this.logger.error({ msg: 'consumer.message_dead_lettered', ...logContext });
        return { kind: 'dead-lettered', reason };
      } catch (dlqError) {
        // Sem ack: a redrive policy da fila é a rede de segurança.
        this.logger.error({
          msg: 'consumer.dead_letter_failed',
          ...logContext,
          dlqError: errorMessage(dlqError),
        });
      }
    }

    const delaySeconds = Math.min(
      this.retryBaseDelaySeconds * 2 ** Math.max(0, receiveCount - 1),
      900,
    );

    try {
      await this.sqs.changeCommandVisibility(message.ReceiptHandle ?? '', delaySeconds);
    } catch (visibilityError) {
      this.logger.warn({
        msg: 'consumer.visibility_change_failed',
        ...logContext,
        visibilityError: errorMessage(visibilityError),
      });
    }

    this.metrics.increment('sqs_message_retries_total', { reason });
    this.logger.warn({ msg: 'consumer.message_retry_scheduled', delaySeconds, ...logContext });

    return { kind: 'retry-scheduled', delaySeconds, reason };
  }

  private async releaseUnprocessed(messages: Message[]): Promise<void> {
    await Promise.allSettled(
      messages.map((message) =>
        this.sqs.changeCommandVisibility(message.ReceiptHandle ?? '', 0),
      ),
    );
  }

  private async parseEnvelope(message: Message): Promise<WagerCommandEnvelope> {
    if (!message.Body || !message.ReceiptHandle) {
      throw new InvalidMessageError('SQS message without body or receipt handle');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(message.Body);
    } catch {
      throw new InvalidMessageError('Message body is not valid JSON');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InvalidMessageError('Message body must be a JSON object');
    }

    const envelope = parsed as Record<string, unknown>;

    if (
      typeof envelope.messageId !== 'string' ||
      !envelope.messageId.trim() ||
      envelope.messageId.length > 255
    ) {
      throw new InvalidMessageError('Invalid messageId');
    }

    if (envelope.type !== EXPECTED_MESSAGE_TYPE) {
      throw new InvalidMessageError(`Unsupported message type: ${String(envelope.type)}`);
    }

    if (
      typeof envelope.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(envelope.occurredAt))
    ) {
      throw new InvalidMessageError('Invalid occurredAt');
    }

    if (typeof envelope.data !== 'object' || envelope.data === null) {
      throw new InvalidMessageError('Invalid data');
    }

    const data = plainToInstance(WagerTransactionRequestedDataDto, envelope.data);
    const errors = await validate(data, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {
      const details = errors
        .flatMap((error) => [
          ...Object.values(error.constraints ?? {}),
          ...(error.children ?? []).flatMap((child) =>
            Object.values(child.constraints ?? {}),
          ),
        ])
        .join('; ');

      throw new InvalidMessageError(`Invalid data: ${details}`);
    }

    const correlationId =
      typeof envelope.correlationId === 'string' && envelope.correlationId.trim()
        ? envelope.correlationId.trim()
        : undefined;

    return {
      messageId: envelope.messageId.trim(),
      type: EXPECTED_MESSAGE_TYPE,
      occurredAt: envelope.occurredAt,
      correlationId,
      payloadHash: sha256Hex(
        canonicalJson({
          messageId: envelope.messageId,
          type: envelope.type,
          data: envelope.data,
        }),
      ),
      command: {
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        idempotencyKey: data.idempotencyKey,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: { amount: data.money.amount, currency: data.money.currency },
        referenceExternalTransactionId: data.referenceExternalTransactionId,
      },
    };
  }
}

/**
 * Permanente = repetir não muda o resultado e não há registro a confirmar:
 * mensagem inválida, conflitos de idempotência/inbox, wallet inexistente,
 * violações de domínio. Rejeições de negócio NÃO chegam aqui: elas são
 * persistidas como REJECTED e confirmadas (ack) normalmente.
 */
function isPermanentFailure(error: unknown): boolean {
  if (error instanceof DomainError) {
    return true;
  }

  if (error instanceof UniqueConstraintViolationException) {
    return true;
  }

  // Erros desconhecidos são tratados como transitórios: novas tentativas com
  // backoff até o limite, depois DLQ (nada se perde).
  return false;
}

function failureCodeOf(error: unknown): string {
  if (error instanceof DomainError) {
    return error.code;
  }

  if (error instanceof UniqueConstraintViolationException) {
    return 'UNIQUE_CONSTRAINT_CONFLICT';
  }

  return 'PERMANENT_FAILURE';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
