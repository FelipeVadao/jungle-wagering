/**
 * Preload do `bun test`: roda antes de qualquer arquivo de teste. Variáveis já
 * definidas em process.env têm precedência sobre o .env (Bun, dotenv e
 * @nestjs/config respeitam essa ordem).
 */
const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const queueBase = `${endpoint}/000000000000`;

const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  DB_NAME: process.env.TEST_DB_NAME ?? 'wagering_test',
  DB_DEBUG: 'false',
  DB_POOL_MAX: '20',
  DB_LOCK_TIMEOUT_MS: '10000',
  SQS_ENDPOINT: endpoint,
  SQS_COMMAND_QUEUE_URL: `${queueBase}/wager-transactions-test.fifo`,
  SQS_COMMAND_DLQ_URL: `${queueBase}/wager-transactions-test-dlq.fifo`,
  SQS_EVENT_QUEUE_URL: `${queueBase}/wager-events-test.fifo`,
  // Workers em background desligados: cada teste os aciona explicitamente.
  SQS_CONSUMER_ENABLED: 'false',
  OUTBOX_PUBLISHER_ENABLED: 'false',
  PENDING_REFERENCE_WORKER_ENABLED: 'false',
  SQS_MAX_RECEIVE_COUNT: '3',
  SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
  SQS_WAIT_TIME_SECONDS: '1',
  SQS_RETRY_BASE_DELAY_SECONDS: '1',
  PENDING_REFERENCE_BASE_DELAY_MS: '1',
  PENDING_REFERENCE_MAX_DELAY_MS: '5',
  PENDING_REFERENCE_MAX_ATTEMPTS: '3',
  OUTBOX_RETRY_BASE_DELAY_MS: '1000',
  LOG_FORMAT: 'json',
};

for (const [key, value] of Object.entries(testEnv)) {
  process.env[key] = value;
}
