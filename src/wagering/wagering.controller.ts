import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { MoneyProps } from '../common/domain/money';
import { CORRELATION_HEADER } from '../common/http/correlation-id.middleware';

import { WagerTransactionStatus } from './domain/wager-transaction';
import { SubmitWagerTransactionDto } from './dto/process-bet.dto';
import {
  WageringService,
  WagerSubmissionResult,
  WagerTransactionView,
} from './wagering.service';

export interface WagerSubmissionResponse {
  transactionId: string;
  status: string;
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  failureCode?: string;
}

/**
 * O status HTTP deriva do estado da transação, então um replay devolve o
 * mesmo código da resposta original (apenas `idempotentReplay: true`).
 */
export function httpStatusFor(status: WagerTransactionStatus): HttpStatus {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.CREATED;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

export function toSubmissionResponse(
  result: WagerSubmissionResult,
): WagerSubmissionResponse {
  const { transaction } = result;
  const response: WagerSubmissionResponse = {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.observedBalance?.toJSON() ?? null,
    idempotentReplay: result.idempotentReplay,
  };

  if (transaction.failureCode) {
    response.failureCode = transaction.failureCode;
  }

  return response;
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(private readonly wageringService: WageringService) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: SubmitWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers(CORRELATION_HEADER) correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerSubmissionResponse> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException({
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required',
      });
    }

    const result = await this.wageringService.submit(
      {
        providerId: body.providerId,
        externalTransactionId: body.externalTransactionId,
        idempotencyKey,
        playerId: body.playerId,
        walletId: body.walletId,
        roundId: body.roundId,
        gameId: body.gameId,
        kind: body.kind,
        money: { amount: body.money.amount, currency: body.money.currency },
        referenceExternalTransactionId: body.referenceExternalTransactionId,
      },
      { channel: 'http', correlationId, causationId: correlationId },
    );

    response.status(httpStatusFor(result.transaction.status));

    return toSubmissionResponse(result);
  }

  @Get('wagering/transactions/:transactionId')
  findById(
    @Param('transactionId', ParseUUIDPipe) transactionId: string,
  ): Promise<WagerTransactionView> {
    return this.wageringService.findById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  findByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.wageringService.findByExternalId(providerId, externalTransactionId);
  }
}
