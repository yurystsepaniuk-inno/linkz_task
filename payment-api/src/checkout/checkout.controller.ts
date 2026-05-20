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
import { CheckoutService } from './checkout.service';
import { CreateSessionDto, PayDto } from './checkout.dto';
import { ApiKeyGuard } from './api-key.guard';

@Controller('api/checkout/sessions')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ApiKeyGuard)
  createSession(@Body() dto: CreateSessionDto) {
    return this.checkoutService.createSession(dto);
  }

  @Get(':sessionId')
  getSession(@Param('sessionId') sessionId: string) {
    return this.checkoutService.getSession(sessionId);
  }

  @Post(':sessionId/pay')
  pay(@Param('sessionId') sessionId: string, @Body() dto: PayDto) {
    return this.checkoutService.pay(sessionId, dto);
  }
}
