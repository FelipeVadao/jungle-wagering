
import { Type } from 'class-transformer';

import {
  IsDefined,
  IsEnum,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { WagerTransactionType } from '../entities/wager-transaction.entity';

// Mantém o nome utilizado pelo restante do projeto,
// mas reutiliza o enum oficial da entidade.
export { WagerTransactionType as WagerOperationType };

export class MoneyDto {
  @IsString()
  @Matches(/^(0|[1-9]\d*)\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class ProcessBetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  gameId!: string;

  @IsEnum(WagerTransactionType)
  kind!: WagerTransactionType;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ValidateIf(
    (dto: ProcessBetDto) =>
      dto.kind === WagerTransactionType.REFUND ||
      dto.kind === WagerTransactionType.ROLLBACK,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  referenceExternalTransactionId?: string;

  // Compatibilidade temporária com trechos antigos do projeto.
  get type(): WagerTransactionType {
    return this.kind;
  }

  get amount(): string {
    return this.money.amount;
  }
}
