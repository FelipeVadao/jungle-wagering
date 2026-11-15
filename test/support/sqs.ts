import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

/** Cliente SQS "cru" para inspecionar filas nos testes (fora da aplicação). */
export function testSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

/**
 * Procura na fila uma mensagem cujo corpo satisfaça `match` e a remove.
 * Mensagens que não casam ficam invisíveis por 1 s antes de voltarem à fila;
 * use em filas de inspeção (DLQ) ou quando o teste controla o conteúdo.
 */
export async function takeMessage(
  queueUrl: string,
  match: (body: Record<string, unknown>, message: Message) => boolean,
  timeoutMs = 15_000,
): Promise<Message | undefined> {
  const client = testSqsClient();
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { Messages = [] } = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 1,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['All'],
        }),
      );

      for (const message of Messages) {
        let body: Record<string, unknown> = {};

        try {
          body = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
        } catch {
          // corpo inválido: só casa via `message`
        }

        if (match(body, message)) {
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
          return message;
        }
      }
    }

    return undefined;
  } finally {
    client.destroy();
  }
}
