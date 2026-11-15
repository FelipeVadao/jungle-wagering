import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { CORRELATION_HEADER } from '../common/http/correlation-id.middleware';

import { CreateWalletDto, LedgerQueryDto } from './dto/create-wallet.dto';
import {
  LedgerPage,
  ReconciliationReport,
  WalletsService,
  WalletView,
} from './wallets.service';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() body: CreateWalletDto,
    @Headers(CORRELATION_HEADER) correlationId: string,
  ): Promise<WalletView> {
    return this.walletsService.create(body, correlationId);
  }

  @Get(':walletId')
  findById(
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<WalletView> {
    return this.walletsService.findById(walletId);
  }

  @Get(':walletId/ledger')
  findLedger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query() query: LedgerQueryDto,
  ): Promise<LedgerPage> {
    return this.walletsService.findLedger(walletId, query.cursor, query.limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(
    @Param('walletId', ParseUUIDPipe) walletId: string,
  ): Promise<ReconciliationReport> {
    return this.walletsService.reconcile(walletId);
  }
}
