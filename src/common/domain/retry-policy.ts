/**
 * Backoff exponencial com teto: delay(n) = min(base * 2^n, max).
 *
 * Sem jitter para manter o comportamento determinístico e testável; o
 * espalhamento entre instâncias vem do `FOR UPDATE SKIP LOCKED`/locks.
 */
export class RetryPolicy {
  constructor(
    readonly baseDelayMs: number,
    readonly maxDelayMs: number,
    readonly maxAttempts: number,
  ) {
    if (baseDelayMs <= 0 || maxDelayMs < baseDelayMs || maxAttempts < 1) {
      throw new Error('Invalid retry policy');
    }
  }

  delayFor(attempt: number): number {
    const exponent = Math.max(0, Math.min(attempt, 30));
    return Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
  }

  nextAttemptAt(now: Date, attempt: number): Date {
    return new Date(now.getTime() + this.delayFor(attempt));
  }
}
