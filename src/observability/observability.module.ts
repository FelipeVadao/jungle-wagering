import { Controller, Get, Global, Header, Module } from '@nestjs/common';

import { MetricsService } from './metrics.service';

/** Exposição Prometheus (aberta, como os health checks). */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): string {
    return this.metrics.render();
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class ObservabilityModule {}
