import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';

/**
 * SQLSTATEs que indicam falha temporária (vale repetir a operação):
 * 40001 serialization_failure, 40P01 deadlock, 55P03 lock_not_available
 * (lock_timeout), 57014 query_canceled (statement_timeout), 57P01..03
 * shutdown/indisponível, 53300 too_many_connections, 08xxx conexão.
 */
const TRANSIENT_SQL_STATES = new Set([
  '40001',
  '40P01',
  '55P03',
  '57014',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
]);

const TRANSIENT_ERROR_NAMES = new Set([
  'TimeoutError',
  'AbortError',
  'NetworkingError',
  'RequestTimeout',
  'ServiceUnavailable',
  'ThrottlingException',
  'RequestThrottled',
  'InternalError',
]);

export function isLockConflictError(error: unknown): boolean {
  if (
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException
  ) {
    return true;
  }

  const code = sqlStateOf(error);
  return code === '40001' || code === '40P01' || code === '55P03';
}

/** true quando a falha é de infraestrutura e pode ter sucesso numa nova tentativa. */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof ConnectionException || isLockConflictError(error)) {
    return true;
  }

  const code = sqlStateOf(error);

  if (code && (TRANSIENT_SQL_STATES.has(code) || code.startsWith('08'))) {
    return true;
  }

  const networkCode = (error as { code?: unknown }).code;

  if (typeof networkCode === 'string' && TRANSIENT_NETWORK_CODES.has(networkCode)) {
    return true;
  }

  const aws = error as { $retryable?: unknown; $metadata?: { httpStatusCode?: number } };

  if (aws.$retryable || (aws.$metadata?.httpStatusCode ?? 0) >= 500) {
    return true;
  }

  if (TRANSIENT_ERROR_NAMES.has(error.name)) {
    return true;
  }

  return /connection (terminated|refused|reset)|timeout exceeded when trying to connect|Connection terminated/i.test(
    error.message,
  );
}

function sqlStateOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as { sqlState?: unknown; code?: unknown };

  if (typeof candidate.sqlState === 'string') {
    return candidate.sqlState;
  }

  return typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)
    ? candidate.code
    : undefined;
}
