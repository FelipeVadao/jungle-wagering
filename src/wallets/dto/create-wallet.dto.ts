import {
  IsNotEmpty,
  IsString,
  Length,
  Matches,
} from 'class-validator';

export class CreateWalletDto {
  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}