import { EntityManager } from '@mikro-orm/postgresql';

import { IntegrationEvent } from './domain/integration-event';
import { OutboxMessage } from './domain/outbox-message';
import { OutboxEventEntity } from './entities/outbox-event.entity';

/**
 * Grava o evento na outbox usando o EntityManager da transação corrente:
 * o evento só existe se a alteração financeira for confirmada (mesmo commit).
 * A publicação no SQS acontece depois, pelo OutboxPublisher.
 */
export function enqueueIntegrationEvent(
  tx: EntityManager,
  event: IntegrationEvent<unknown>,
): OutboxMessage {
  const message = OutboxMessage.enqueue(event);

  tx.persist(
    tx.create(OutboxEventEntity, {
      id: message.id,
      eventType: message.eventType,
      aggregateId: message.aggregateId,
      payload: message.payload as Record<string, unknown>,
      status: 'PENDING',
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
      createdAt: message.occurredAt,
      publishedAt: null,
      lastError: null,
    }),
  );

  return message;
}

export function toOutboxMessage(entity: OutboxEventEntity): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: entity.id,
    aggregateId: entity.aggregateId,
    eventType: entity.eventType,
    payload: entity.payload,
    occurredAt: entity.createdAt,
    attempts: entity.attempts,
    nextAttemptAt: entity.nextAttemptAt,
    publishedAt: entity.publishedAt ?? undefined,
    lastError: entity.lastError ?? undefined,
  });
}

export function applyOutboxMessage(
  message: OutboxMessage,
  entity: OutboxEventEntity,
): void {
  entity.attempts = message.attempts;
  entity.lastError = message.lastError ?? null;

  if (message.publishedAt) {
    entity.status = 'PUBLISHED';
    entity.publishedAt = message.publishedAt;
  } else if (message.nextAttemptAt) {
    entity.nextAttemptAt = message.nextAttemptAt;
  }
}
