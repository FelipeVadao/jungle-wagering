import {
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';

import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
  ) {}

  @Post()
  create(@Body() body: CreateWalletDto) {
    return this.walletsService.create(body);
  }

  @Post(':walletId/reconciliation')
reconcile(@Param('walletId') walletId: string) {
  return this.walletsService.reconcile(walletId);
}

  @Get(':walletId')
  findById(@Param('walletId') walletId: string) {
    return this.walletsService.findById(walletId);
  }

  @Get(':walletId/ledger')
findLedger(@Param('walletId') walletId: string) {
  return this.walletsService.findLedger(walletId);
}
}
