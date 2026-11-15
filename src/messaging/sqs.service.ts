import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  Message,
  MessageAttributeValue,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export interface ReceiveOptions {
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  abortSignal?: AbortSignal;
}

/**
 * Adaptador do SQS.
 *
 * - fila de entrada (comandos `WagerTransactionRequested`): wager-transactions.fifo
 * - DLQ da entrada: wager-transactions-dlq.fifo
 * - fila de eventos de integração (outbox): wager-events.fifo
 */
@Injectable()
export class SqsService implements OnModuleDestroy {
  private readonly client: SQSClient;
  readonly commandQueueUrl: string;
  readonly commandDlqUrl: string;
  readonly eventQueueUrl: string;

  constructor(config: ConfigService) {
    this.commandQueueUrl = config.getOrThrow<string>('SQS_COMMAND_QUEUE_URL');
    this.commandDlqUrl = config.getOrThrow<string>('SQS_COMMAND_DLQ_URL');
    this.eventQueueUrl = config.getOrThrow<string>('SQS_EVENT_QUEUE_URL');

    this.client = new SQSClient({
      region: config.get<string>('AWS_REGION', 'us-east-1'),
      endpoint: config.get<string>('SQS_ENDPOINT'),
      credentials: {
        accessKeyId: config.get<string>('AWS_ACCESS_KEY_ID', 'test'),
        secretAccessKey: config.get<string>('AWS_SECRET_ACCESS_KEY', 'test'),
      },
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 25_000 },
    });
  }

  /** Publica um evento da outbox. Deduplicação FIFO pelo eventId. */
  async publishEvent(
    payload: unknown,
    messageGroupId: string,
    eventId: string,
  ): Promise<{ messageId?: string }> {
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.eventQueueUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: eventId,
      }),
    );

    return { messageId: result.MessageId };
  }

  /** Envia um comando para a fila de entrada (ferramentas e testes). */
  async publishCommand(
    payload: unknown,
    messageGroupId: string,
    deduplicationId: string,
  ): Promise<{ messageId?: string }> {
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.commandQueueUrl,
        MessageBody: JSON.stringify(payload),
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );

    return { messageId: result.MessageId };
  }

  async receiveCommands(options: ReceiveOptions): Promise<Message[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.commandQueueUrl,
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitTimeSeconds,
        VisibilityTimeout: options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: options.abortSignal },
    );

    return result.Messages ?? [];
  }

  /** ACK: remove a mensagem da fila (somente após o commit). */
  async deleteCommand(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.commandQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  /** Devolve a mensagem para a fila após `seconds` (0 = imediatamente). */
  async changeCommandVisibility(
    receiptHandle: string,
    seconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.commandQueueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.min(Math.floor(seconds), 43_200)),
      }),
    );
  }

  /** Move explicitamente uma mensagem para a DLQ, preservando corpo e motivo. */
  async sendToDeadLetterQueue(
    message: Message,
    reason: string,
    detail: string,
  ): Promise<void> {
    const attributes: Record<string, MessageAttributeValue> = {
      failureReason: { DataType: 'String', StringValue: reason },
      failureDetail: { DataType: 'String', StringValue: detail.slice(0, 1000) || '-' },
      originalMessageId: {
        DataType: 'String',
        StringValue: message.MessageId ?? 'unknown',
      },
      receiveCount: {
        DataType: 'Number',
        StringValue: message.Attributes?.ApproximateReceiveCount ?? '1',
      },
    };

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.commandDlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId ?? `${Date.now()}`,
        MessageAttributes: attributes,
      }),
    );
  }

  /** Readiness: a fila de entrada responde. */
  async ping(timeoutMs = 2000): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.commandQueueUrl,
        AttributeNames: ['QueueArn'],
      }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
