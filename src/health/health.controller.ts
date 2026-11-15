import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { Response } from 'express';

import { SqsService } from '../messaging/sqs.service';

interface DependencyCheck {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

/** Endpoints abertos (sem autenticação), conforme o desafio. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
  ) {}

  /** Liveness: o processo está vivo e respondendo. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const [database, sqs] = await Promise.all([
      check(() => this.em.fork().execute('select 1')),
      check(() => this.sqs.ping()),
    ]);
    const ready = database.status === 'up' && sqs.status === 'up';

    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return { status: ready ? 'ok' : 'unavailable', checks: { database, sqs } };
  }
}

async function check(probe: () => Promise<unknown>): Promise<DependencyCheck> {
  const startedAt = performance.now();

  try {
    await withTimeout(probe(), 2000);
    return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.name : 'Error',
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
