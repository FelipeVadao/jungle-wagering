import { DomainError } from '../domain/domain-error';

/** Erros de aplicação que NÃO geram registro persistido (nada a auditar). */

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

/** Mesma Idempotency-Key com payload diferente: conflito, nunca replay. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
}

/** Mesmo (providerId, externalTransactionId) sob outra Idempotency-Key. */
export class ExternalTransactionConflictError extends DomainError {
  readonly code = 'EXTERNAL_TRANSACTION_ID_CONFLICT';
}

export class InvalidIdempotencyKeyError extends DomainError {
  readonly code = 'INVALID_IDEMPOTENCY_KEY';
}

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';
}

/** Mesma messageId (SQS) com corpo diferente. */
export class InboxPayloadConflictError extends DomainError {
  readonly code = 'INBOX_PAYLOAD_CONFLICT';
}

/** Mensagem SQS malformada (JSON, envelope ou dados inválidos). */
export class InvalidMessageError extends DomainError {
  readonly code = 'INVALID_MESSAGE';
}
