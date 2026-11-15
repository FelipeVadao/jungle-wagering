import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from '@aws-sdk/client-sqs';

@Injectable()
export class SqsService implements OnModuleDestroy {
  private readonly client: SQSClient;
  private readonly commandQueueUrl: string;
  private readonly eventQueueUrl: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.commandQueueUrl = config.getOrThrow<string>(
      'SQS_COMMAND_QUEUE_URL',
    );

    this.eventQueueUrl = config.getOrThrow<string>(
      'SQS_EVENT_QUEUE_URL',
    );

    this.client = new SQSClient({
      region: config.get<string>('AWS_REGION', 'us-east-1'),
      endpoint: config.get<string>('SQS_ENDPOINT'),
      credentials: {
        accessKeyId: config.get<string>('AWS_ACCESS_KEY_ID', 'test'),
        secretAccessKey: config.get<string>(
          'AWS_SECRET_ACCESS_KEY',
          'test',
        ),
      },
    });
  }

  async publishEvent(
    payload: unknown,
    messageGroupId: string,
    eventId: string,
  ) {
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

  async publishCommand(
    payload: unknown,
    messageGroupId: string,
    deduplicationId: string,
  ) {
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

  async receiveCommands(
    maxNumberOfMessages = 10,
    waitTimeSeconds = 20,
  ): Promise<Message[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.commandQueueUrl,
        MaxNumberOfMessages: maxNumberOfMessages,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: 30,
        AttributeNames: ['All'],
      }),
    );

    return result.Messages ?? [];
  }

  async deleteCommand(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.commandQueueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
