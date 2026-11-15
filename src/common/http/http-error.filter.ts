import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { Response } from 'express';

import { DomainError } from '../domain/domain-error';
import { isTransientError } from '../errors/transient-error';

/**
 * Mapeamento HTTP consistente em todos os endpoints (ver ARCHITECTURE.md):
 *
 *   400 payload inválido            (VALIDATION_ERROR, INVALID_MONEY, ...)
 *   404 recurso inexistente         (WALLET_NOT_FOUND, TRANSACTION_NOT_FOUND)
 *   409 conflito de idempotência    (IDEMPOTENCY_KEY_CONFLICT, ...)
 *   422 rejeição de negócio         (resposta do recurso com status REJECTED)
 *   202 aceito, pendente            (PENDING_REFERENCE)
 *   503 falha transitória de infra  (banco/SQS indisponível, lock timeout) + Retry-After
 */
const DOMAIN_STATUS: Record<string, HttpStatus> = {
  INVALID_MONEY: HttpStatus.BAD_REQUEST,
  CURRENCY_MISMATCH: HttpStatus.BAD_REQUEST,
  INVALID_WAGER_TRANSACTION: HttpStatus.BAD_REQUEST,
  INVALID_WALLET_OPERATION: HttpStatus.BAD_REQUEST,
  INVALID_IDEMPOTENCY_KEY: HttpStatus.BAD_REQUEST,
  INVALID_CURSOR: HttpStatus.BAD_REQUEST,
  WALLET_NOT_FOUND: HttpStatus.NOT_FOUND,
  TRANSACTION_NOT_FOUND: HttpStatus.NOT_FOUND,
  IDEMPOTENCY_KEY_CONFLICT: HttpStatus.CONFLICT,
  EXTERNAL_TRANSACTION_ID_CONFLICT: HttpStatus.CONFLICT,
  WALLET_ALREADY_EXISTS: HttpStatus.CONFLICT,
};

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const correlationId = request?.headers?.['x-correlation-id'];
    const body = this.toBody(exception);

    if (body.statusCode === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', '1');
    }

    if (body.statusCode >= 500) {
      this.logger.error({
        msg: 'http.request_failed',
        correlationId,
        code: body.code,
        error: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }

    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof DomainError) {
      const statusCode =
        DOMAIN_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

      return {
        statusCode,
        code: statusCode === HttpStatus.INTERNAL_SERVER_ERROR ? 'INTERNAL_ERROR' : exception.code,
        message:
          statusCode === HttpStatus.INTERNAL_SERVER_ERROR
            ? 'Internal server error'
            : exception.message,
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const response = exception.getResponse();
      const payload =
        typeof response === 'object' && response !== null
          ? (response as Record<string, unknown>)
          : { message: response };

      return {
        statusCode,
        code:
          typeof payload.code === 'string'
            ? payload.code
            : defaultCode(statusCode),
        message: Array.isArray(payload.message)
          ? 'Invalid payload'
          : typeof payload.message === 'string'
            ? payload.message
            : exception.message,
        details: payload.details ?? (Array.isArray(payload.message) ? payload.message : undefined),
      };
    }

    if (exception instanceof UniqueConstraintViolationException) {
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'CONFLICT',
        message: 'Request conflicts with an existing resource',
      };
    }

    if (isTransientError(exception)) {
      return {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'TRANSIENT_FAILURE',
        message: 'Temporary infrastructure failure, retry with the same Idempotency-Key',
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'VALIDATION_ERROR';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    default:
      return 'HTTP_ERROR';
  }
}
