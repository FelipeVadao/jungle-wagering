import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { Wallet } from './entities/wallet.entity';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { LedgerEntry } from './entities/ledger-entry.entity';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      Wallet,
      LedgerEntry,
    ]),
  ],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
