import { RetryPolicy } from '../../common/domain/retry-policy';

import { IntegrationEvent } from './integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  lastError?: string;
}

/**
 * Mensagem da Transactional Outbox. É gravada na mesma transação SQL da
 * alteração financeira e publicada depois do commit por um worker.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined ||
        this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      return;
    }

    this._publishedAt = at;
    this._nextAttemptAt = undefined;
    this._lastError = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff). */
  scheduleRetry(now: Date, policy: RetryPolicy, error?: string): void {
    this._attempts += 1;
    this._nextAttemptAt = policy.nextAttemptAt(now, this._attempts - 1);
    this._lastError = error?.slice(0, 1000);
  }
}
