import { randomUUID } from 'node:crypto';

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';

/** Propaga (ou gera) o X-Correlation-Id da requisição até os eventos e logs. */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const incoming = request.headers[CORRELATION_HEADER];
    const correlationId =
      typeof incoming === 'string' && /^[\w.:-]{1,128}$/.test(incoming)
        ? incoming
        : randomUUID();

    request.headers[CORRELATION_HEADER] = correlationId;
    response.setHeader(CORRELATION_HEADER, correlationId);
    next();
  }
}
