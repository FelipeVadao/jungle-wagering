import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
} from '@nestjs/common';

import { ProcessBetDto } from './dto/process-bet.dto';
import { WageringService } from './wagering.service';

@Controller('wagering')
export class WageringController {
  constructor(
    private readonly wageringService: WageringService,
  ) {}

  @Post('transactions')
  processBet(
    @Body() body: ProcessBetDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException(
        'Idempotency-Key header is required',
      );
    }

    return this.wageringService.processBet(
      body,
      idempotencyKey,
    );
  }
}
