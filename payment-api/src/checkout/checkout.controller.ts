import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { CreateSessionDto, PayDto } from './checkout.dto';
import { ApiKeyGuard } from './api-key.guard';
import { PollRateLimitGuard } from './poll-rate-limit.guard';
import { DELIVERY_STATUS, PAYMENT_ERROR_CODE } from '../common/constants';
import { MESSAGES } from '../common/messages';

@Controller('api/checkout/sessions')
export class CheckoutController {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly deliveries: WebhookDeliveryService,
  ) {}

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

  /**
   * Service-to-service status lookup. Locked behind `x-api-key` because the
   * only legitimate caller is reservation-api's reconciliation cron — the
   * checkout UI uses `GET /:sessionId` instead. Returning the status to the
   * buyer would leak information about other users' payments.
   */
  @Get(':sessionId/status')
  @UseGuards(ApiKeyGuard)
  getSessionStatus(@Param('sessionId') sessionId: string) {
    return this.checkoutService.getSessionStatus(sessionId);
  }

  /**
   * Buyer-facing webhook delivery status. Powers ResultPage polling so the
   * user can see the "still syncing" banner clear when reservation-api has
   * actually received the event. Returns only the delivery state — no
   * counterparty data — so it's safe without an API key; session ids are
   * unguessable UUIDs the buyer already holds.
   *
   * Rate-limited per IP (`PollRateLimitGuard`) because there is no auth: the
   * cap stops the endpoint from being abused as an unauthenticated heartbeat
   * while leaving ample room for the frontend's backoff-paced polling.
   */
  @Get(':sessionId/delivery-status')
  @UseGuards(PollRateLimitGuard)
  async getDeliveryStatus(@Param('sessionId') sessionId: string) {
    // 404 on guessed-bad ids instead of leaking "delivery unknown" via the
    // delivery row. `assertSessionExists` is the bare existence probe — no
    // session payload crosses this controller (which is unauthenticated).
    await this.checkoutService.assertSessionExists(sessionId);
    const record = await this.deliveries.getStatusBySession(sessionId);
    if (!record) {
      throw new NotFoundException({
        message: MESSAGES.deliveries.notFound,
        code: PAYMENT_ERROR_CODE.SESSION_NOT_FOUND,
      });
    }
    return {
      status: record.status,
      attempts: record.attempts,
      // Surface the next-attempt timestamp so the client can back off its own
      // poll cadence when the backend is already scheduled to retry shortly.
      nextAttemptAt: record.next_attempt_at?.toISOString() ?? null,
      // `DELIVERY_STATUS.DELIVERED` is the terminal happy state — exposed as
      // a constant for assertion at the call site.
      terminalDelivered: record.status === DELIVERY_STATUS.DELIVERED,
    };
  }

  @Post(':sessionId/pay')
  pay(@Param('sessionId') sessionId: string, @Body() dto: PayDto) {
    return this.checkoutService.pay(sessionId, dto);
  }
}
