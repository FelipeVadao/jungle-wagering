import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export interface SqsTopology {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  commandQueueUrl: string;
  commandDlqUrl: string;
  eventQueueUrl: string;
  /** Limite de recebimentos da aplicação; a redrive policy usa um valor maior. */
  maxReceiveCount: number;
}

export function topologyFromEnv(env: NodeJS.ProcessEnv = process.env): SqsTopology {
  const required = (key: string): string => {
    const value = env[key];

    if (!value) {
      throw new Error(`Missing ${key}`);
    }

    return value;
  };

  return {
    endpoint: env.SQS_ENDPOINT,
    region: env.AWS_REGION ?? 'us-east-1',
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
    commandQueueUrl: required('SQS_COMMAND_QUEUE_URL'),
    commandDlqUrl: required('SQS_COMMAND_DLQ_URL'),
    eventQueueUrl: required('SQS_EVENT_QUEUE_URL'),
    maxReceiveCount: Number(env.SQS_MAX_RECEIVE_COUNT ?? 5),
  };
}

function queueName(url: string): string {
  const name = url.split('/').pop();

  if (!name) {
    throw new Error(`Invalid queue URL: ${url}`);
  }

  return name;
}

/**
 * Cria (idempotente) as filas FIFO:
 *   - entrada  + DLQ (redrive policy como rede de segurança para crashes);
 *   - eventos de integração publicados pela outbox.
 */
export async function ensureQueues(
  topology: SqsTopology,
  options: { purge?: boolean } = {},
): Promise<void> {
  const client = new SQSClient({
    region: topology.region,
    endpoint: topology.endpoint,
    credentials: {
      accessKeyId: topology.accessKeyId,
      secretAccessKey: topology.secretAccessKey,
    },
  });

  const ensure = async (
    url: string,
    attributes: Record<string, string> = {},
  ): Promise<string> => {
    const name = queueName(url);
    const fifo = {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
    };

    try {
      const created = await client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: { ...fifo, ...attributes },
        }),
      );

      return created.QueueUrl ?? url;
    } catch {
      const { QueueUrl } = await client.send(
        new GetQueueUrlCommand({ QueueName: name }),
      );

      if (Object.keys(attributes).length > 0) {
        await client.send(
          new SetQueueAttributesCommand({
            QueueUrl,
            Attributes: attributes,
          }),
        );
      }

      return QueueUrl ?? url;
    }
  };

  try {
    const dlqUrl = await ensure(topology.commandDlqUrl);
    const { Attributes } = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['QueueArn'],
      }),
    );

    const commandUrl = await ensure(topology.commandQueueUrl, {
      VisibilityTimeout: '30',
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: Attributes?.QueueArn,
        maxReceiveCount: String(topology.maxReceiveCount + 2),
      }),
    });
    const eventUrl = await ensure(topology.eventQueueUrl);

    if (options.purge) {
      for (const url of [commandUrl, dlqUrl, eventUrl]) {
        await client.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
      }
    }
  } finally {
    client.destroy();
  }
}
