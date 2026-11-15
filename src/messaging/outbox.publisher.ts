import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/postgresql';

import { RetryPolicy } from '../common/domain/retry-policy';
import { MetricsService } from '../observability/metrics.service';
import { positiveInt } from '../wagering/wagering.service';

import { OutboxEventEntity } from './entities/outbox-event.entity';
import { applyOutboxMessage, toOutboxMessage } from './outbox.writer';
import { SqsService } from './sqs.service';

/**
 * Publica eventos pendentes da outbox no SQS.
 *
 * Concorrência entre publishers (várias instâncias): cada lote é reivindicado
 * com `SELECT ... FOR UPDATE SKIP LOCKED` dentro de uma transação que só
 * termina depois do envio. Enquanto um publisher segura as linhas, os demais
 * as pulam — o mesmo evento nunca é enviado por dois publishers ao mesmo
 * tempo. Se o processo morrer depois do envio e antes do commit, a transação
 * é desfeita, o evento volta a ficar disponível e é publicado de novo
 * (at-least-once): a duplicata é segura porque o consumidor deduplica pelo
 * `eventId` (também usado como MessageDeduplicationId na fila FIFO).
 */
@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);
  readonly batchSize: number;
  private readonly retryPolicy: RetryPolicy;

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.batchSize = positiveInt(config.get('OUTBOX_BATCH_SIZE'), 50);
    this.retryPolicy = new RetryPolicy(
      positiveInt(config.get('OUTBOX_RETRY_BASE_DELAY_MS'), 1000),
      positiveInt(config.get('OUTBOX_RETRY_MAX_DELAY_MS'), 300_000),
      Number.MAX_SAFE_INTEGER,
    );
  }

  /** Publica um lote. Retorna quantos eventos foram publicados. */
  async publishPending(batchSize = this.batchSize): Promise<number> {
    return this.em.fork().transactional(async (tx) => {
      // Um evento em backoff bloqueia os posteriores do mesmo agregado (não
      // são publicados "por cima" dele). A ordem entre publishers distintos
      // continua best-effort: ver ARCHITECTURE.md.
      const claimed = await tx.execute<Array<{ id: string }>>(
        `select o."id"
           from "outbox_events" o
          where o."status" = 'PENDING'
            and o."next_attempt_at" <= now()
            and not exists (
                  select 1
                    from "outbox_events" earlier
                   where earlier."aggregate_id" = o."aggregate_id"
                     and earlier."status" = 'PENDING'
                     and earlier."next_attempt_at" > now()
                     and (earlier."created_at", earlier."id") < (o."created_at", o."id")
                )
          order by o."created_at" asc, o."id" asc
          limit ?
          for update of o skip locked`,
        [batchSize],
      );

      if (claimed.length === 0) {
        return 0;
      }

      const entities = await tx.find(OutboxEventEntity, {
        id: { $in: claimed.map((row) => row.id) },
      });
      const byId = new Map(entities.map((entity) => [entity.id, entity]));
      const blockedAggregates = new Set<string>();
      let published = 0;

      // Itera na ordem do SELECT (created_at, id): a ordem de publicação é
      // determinística e respeita a ordem de criação.
      for (const { id } of claimed) {
        const entity = byId.get(id);

        if (!entity) {
          continue;
        }

        const message = toOutboxMessage(entity);

        // Uma falha bloqueia os eventos seguintes do mesmo agregado neste
        // lote, para não publicá-los fora de ordem.
        if (blockedAggregates.has(message.aggregateId)) {
          continue;
        }

        try {
          await this.sqs.publishEvent(message.payload, message.aggregateId, message.id);
          message.markPublished(new Date());
          published += 1;
          this.metrics.increment('outbox_published_total', {
            eventType: message.eventType,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          message.scheduleRetry(new Date(), this.retryPolicy, reason);
          blockedAggregates.add(message.aggregateId);
          this.metrics.increment('outbox_publish_failures_total', {
            eventType: message.eventType,
          });
          this.logger.warn({
            msg: 'outbox.publish_failed',
            eventId: message.id,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt?.toISOString(),
            error: reason,
          });
        }

        applyOutboxMessage(message, entity);
      }

      await tx.flush();

      return published;
    });
  }

  /** Atualiza as métricas de lag (idade do evento pendente mais antigo). */
  async refreshLagMetrics(): Promise<{ pending: number; lagSeconds: number }> {
    const [row] = await this.em.fork().execute<
      Array<{ pending: number; lag_seconds: number | string | null }>
    >(
      `select count(*)::int as "pending",
              extract(epoch from (now() - min("created_at"))) as "lag_seconds"
         from "outbox_events"
        where "status" = 'PENDING'`,
    );

    const pending = row?.pending ?? 0;
    const lagSeconds = Math.max(0, Number(row?.lag_seconds ?? 0));

    this.metrics.setGauge('outbox_pending_events', pending);
    this.metrics.setGauge('outbox_lag_seconds', lagSeconds);

    return { pending, lagSeconds };
  }
}
