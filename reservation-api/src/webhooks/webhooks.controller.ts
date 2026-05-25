import {
  Controller,
  Post,
  Body,
  Headers,
  RawBodyRequest,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import { WebhooksService, WebhookPayload } from './webhooks.service';
import { SIGNATURE_HEADER } from '../common/constants';

@Controller('api/webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('payment')
  @HttpCode(HttpStatus.OK)
  handlePayment(
    @Req() req: RawBodyRequest<Request>,
    @Headers(SIGNATURE_HEADER) signature: string,
    @Body() payload: WebhookPayload,
  ) {
    // Signature verification (and its audit row) lives in the service so a
    // rejected webhook is recorded in the ledger, not silently dropped here.
    return this.webhooksService.handle(payload, req.rawBody, signature || '');
  }
}
