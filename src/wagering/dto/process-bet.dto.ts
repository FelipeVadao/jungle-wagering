import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  SUBMITTABLE_KINDS,
  WagerTransactionKind,
} from '../domain/wager-transaction';

/**
 * `{ "amount": "25.00", "currency": "BRL" }` — amount é string decimal com
 * até 2 casas (sem sinal, expoente, NaN ou Infinity). `number` é rejeitado.
 */
export class MoneyDto {
  @IsString()
  @Matches(/^(0|[1-9]\d{0,17})(\.\d{1,2})?$/, {
    message:
      'amount must be a non-negative decimal string with at most 2 decimal places',
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency!: string;
}

/** Corpo de POST /wagering/transactions (Idempotency-Key vem no header). */
export class SubmitWagerTransactionDto {
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

  /** OPENING é interno e não pode ser submetido. */
  @IsIn(SUBMITTABLE_KINDS, {
    message: `kind must be one of: ${SUBMITTABLE_KINDS.join(', ')}`,
  })
  kind!: WagerTransactionKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  /** Obrigatório para REFUND/ROLLBACK; opcional para WIN/LOSS. */
  @ValidateIf(
    (dto: SubmitWagerTransactionDto) =>
      dto.kind === WagerTransactionKind.Refund ||
      dto.kind === WagerTransactionKind.Rollback ||
      dto.referenceExternalTransactionId !== undefined,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  referenceExternalTransactionId?: string;
}

/** `data` da mensagem SQS `WagerTransactionRequested`. */
export class WagerTransactionRequestedDataDto extends SubmitWagerTransactionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotencyKey!: string;
}
