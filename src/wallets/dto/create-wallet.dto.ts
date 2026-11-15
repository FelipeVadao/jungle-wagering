import { Type } from 'class-transformer';
import {
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { MoneyDto } from '../../wagering/dto/process-bet.dto';

/**
 * POST /wallets
 * `{ "playerId": "<uuid>", "initialBalance": { "amount": "1000.00", "currency": "BRL" } }`
 */
export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

/** GET /wallets/:walletId/ledger?cursor=...&limit=50 */
export class LedgerQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
