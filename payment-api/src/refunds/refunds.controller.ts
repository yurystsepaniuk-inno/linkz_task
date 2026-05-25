import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { RefundsService } from './refunds.service';
import { CreateRefundDto } from './refund.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';

@Controller('api/refunds')
@UseGuards(ApiKeyGuard)
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  /**
   * Idempotent refund. The unique constraint on `session_id` means a retry
   * returns the existing row instead of creating a second refund — so a
   * reconciliation cron can call this without bookkeeping.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateRefundDto) {
    return this.refunds.create(dto);
  }

  @Get(':sessionId')
  find(@Param('sessionId') sessionId: string) {
    return this.refunds.findBySession(sessionId);
  }
}
