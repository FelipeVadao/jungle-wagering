import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { LedgerEntryEntity } from '../wallets/entities/ledger-entry.entity';
import { WalletEntity } from '../wallets/entities/wallet.entity';

import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { PendingReferenceWorker } from './pending-reference.worker';
import { WageringController } from './wagering.controller';
import { WageringService } from './wagering.service';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      WagerTransactionEntity,
      WalletEntity,
      LedgerEntryEntity,
    ]),
  ],
  controllers: [WageringController],
  providers: [WageringService, PendingReferenceWorker],
  exports: [WageringService, PendingReferenceWorker],
})
export class WageringModule {}
