import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { LedgerEntryEntity } from './entities/ledger-entry.entity';
import { WalletEntity } from './entities/wallet.entity';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [MikroOrmModule.forFeature([WalletEntity, LedgerEntryEntity])],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
