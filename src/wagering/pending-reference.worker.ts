import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PollingLoop } from '../common/polling-loop';

import { positiveInt, WageringService } from './wagering.service';

/**
 * Worker agendado que reprocessa PENDING_REFERENCE com backoff exponencial
 * (ver RetryPolicy/ARCHITECTURE.md). Pode rodar em todas as instâncias.
 */
@Injectable()
export class PendingReferenceWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private readonly loop: PollingLoop;
  private readonly batchSize: number;

  constructor(
    private readonly wagering: WageringService,
    private readonly config: ConfigService,
  ) {
    this.batchSize = positiveInt(config.get('PENDING_REFERENCE_BATCH_SIZE'), 50);
    this.loop = new PollingLoop(
      'pending-reference-worker',
      positiveInt(config.get('PENDING_REFERENCE_POLL_INTERVAL_MS'), 1000),
      () => this.runOnce().then((handled) => handled >= this.batchSize),
      this.logger,
    );
  }

  onApplicationBootstrap(): void {
    if (this.config.get('PENDING_REFERENCE_WORKER_ENABLED', 'true') !== 'false') {
      this.loop.start();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.loop.stop();
  }

  runOnce(): Promise<number> {
    return this.wagering.retryDuePendingReferences(this.batchSize);
  }
}
