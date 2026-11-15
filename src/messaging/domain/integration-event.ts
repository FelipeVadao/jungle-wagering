import { randomUUID } from 'node:crypto';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Contexto de rastreabilidade propagado da entrada (HTTP/SQS) aos eventos. */
export interface EventContext {
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601 */
  occurredAt: string;
  version: number;
  data: T;
}

/** Monta as props de um evento novo (eventId gerado aqui). */
export function eventProps<T>(
  aggregateId: string,
  ctx: EventContext,
  data: T,
): IntegrationEventProps<T> {
  return {
    eventId: randomUUID(),
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    data,
  };
}

/**
 * Envelope de evento de integração. `eventType` e `version` pertencem ao tipo
 * concreto; `data` carrega apenas JSON estável (MoneyProps, nunca Money).
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };

    if (this.causationId !== undefined) {
      envelope.causationId = this.causationId;
    }

    return envelope;
  }
}
