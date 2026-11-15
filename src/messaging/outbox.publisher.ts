import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { OutboxEvent } from './entities/outbox-event.entity';
import { SqsService } from './sqs.service';

@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,

    @Inject(SqsService)
    private readonly sqs: SqsService,
  ) {}

  async publishPending(): Promise<void> {
    await this.em.transactional(async (tx) => {
      const rows = (await tx.execute(
        `
          SELECT "id"
          FROM "outbox_events"
          WHERE "status" = ?
          ORDER BY "created_at" ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED
        `,
        ['PENDING', 10],
      )) as Array<{ id: string }>;

      if (rows.length === 0) {
        return;
      }

      const ids = rows.map((row) => row.id);

      const events = await tx.find(OutboxEvent, {
        id: { $in: ids },
      });

      for (const event of events) {
        try {
          await this.sqs.publishEvent(
            event.payload,
            event.aggregateId,
            event.id,
          );

          event.status = 'PUBLISHED';
          event.publishedAt = new Date();
          event.lastError = undefined;

          this.logger.log(`Evento ${event.id} publicado`);
        } catch (error) {
          event.attempts += 1;
          event.lastError =
            error instanceof Error ? error.message : String(error);

          this.logger.error(
            `Falha ao publicar evento ${event.id}: ${event.lastError}`,
          );
        }
      }

      await tx.flush();
    });
  }
}
