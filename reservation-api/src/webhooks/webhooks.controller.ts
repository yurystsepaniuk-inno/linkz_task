import {
  Controller,
  Post,
  Body,
  Headers,
  RawBodyRequest,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { WebhooksService, WebhookPayload } from './webhooks.service';
import { SIGNATURE_HEADER } from '../common/constants';
import { MESSAGES } from '../common/messages';

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
    if (!req.rawBody) {
      throw new UnauthorizedException(MESSAGES.webhooks.invalidSignature);
    }
    this.webhooksService.verifySignature(req.rawBody, signature || '');
    return this.webhooksService.handle(payload);
  }
}
