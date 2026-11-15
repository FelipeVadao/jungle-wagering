
import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { WagerTransaction } from './entities/wager-transaction.entity';
import { Wallet } from '../wallets/entities/wallet.entity';
import { LedgerEntry } from '../wallets/entities/ledger-entry.entity';

import { WageringController } from './wagering.controller';
import { WageringService } from './wagering.service';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      WagerTransaction,
      Wallet,
      LedgerEntry,
    ]),
  ],
  controllers: [WageringController],
  providers: [WageringService],
  exports: [WageringService],
})
export class WageringModule {}
