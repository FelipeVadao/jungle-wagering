import { LoggerService } from '@nestjs/common';

/**
 * Loop de polling com parada cooperativa: `stop()` interrompe a espera,
 * aguarda a iteração em andamento terminar e só então resolve.
 * `tick` retorna true quando ainda há trabalho imediato (sem esperar).
 */
export class PollingLoop {
  private running = false;
  private current?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<boolean>,
    private readonly logger: LoggerService,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.current = this.run();
    this.logger.log({ msg: 'worker.started', worker: this.name });
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.wake?.();
    await this.current;
    this.logger.log({ msg: 'worker.stopped', worker: this.name });
  }

  private async run(): Promise<void> {
    while (this.running) {
      let hasMoreWork = false;

      try {
        hasMoreWork = await this.tick();
      } catch (error) {
        this.logger.error({
          msg: 'worker.tick_failed',
          worker: this.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (this.running && !hasMoreWork) {
        await this.sleep(this.intervalMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
