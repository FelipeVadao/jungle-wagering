import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PollingLoop } from '../common/polling-loop';
import { positiveInt } from '../wagering/wagering.service';

import { OutboxPublisher } from './outbox.publisher';

/**
 * Worker que drena a outbox periodicamente. Roda em todas as instâncias;
 * o SKIP LOCKED do publisher divide o trabalho entre elas.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly loop: PollingLoop;

  constructor(
    private readonly publisher: OutboxPublisher,
    private readonly config: ConfigService,
  ) {
    this.loop = new PollingLoop(
      'outbox-relay',
      positiveInt(config.get('OUTBOX_POLL_INTERVAL_MS'), 500),
      async () => {
        const published = await this.publisher.publishPending();
        await this.publisher.refreshLagMetrics();
        return published >= this.publisher.batchSize;
      },
      this.logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.get('OUTBOX_PUBLISHER_ENABLED', 'true') !== 'false') {
      this.loop.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.loop.stop();
  }
}
