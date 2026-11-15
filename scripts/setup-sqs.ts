import 'dotenv/config';

import { ensureQueues, topologyFromEnv } from './lib/sqs-bootstrap';

/** bun run sqs:setup — cria as filas FIFO (idempotente). */
async function main(): Promise<void> {
  const topology = topologyFromEnv();
  await ensureQueues(topology);

  console.log('SQS queues ready:');
  console.log(`  input : ${topology.commandQueueUrl}`);
  console.log(`  dlq   : ${topology.commandDlqUrl}`);
  console.log(`  events: ${topology.eventQueueUrl}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
