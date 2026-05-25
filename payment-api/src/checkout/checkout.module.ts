import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { SessionsRepository } from './sessions.repository';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { CheckoutSessionExpiryRepository } from './checkout-session-expiry.repository';
import { ApiKeyGuard } from './api-key.guard';
import { PollRateLimitGuard } from './poll-rate-limit.guard';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { CheckoutSessionExpirySweeper } from './checkout-session-expiry.sweeper';

@Module({
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    SessionsRepository,
    WebhookDeliveryRepository,
    CheckoutSessionExpiryRepository,
    ApiKeyGuard,
    PollRateLimitGuard,
    WebhookDeliveryService,
    // Background cron that flips abandoned PENDING sessions to EXPIRED once
    // their 30-minute TTL elapses — keeps ops queries against `status` honest.
    CheckoutSessionExpirySweeper,
  ],
  // Re-export so sibling modules (RefundsModule) can read the session
  // lifecycle and reuse the same x-api-key guard without re-providing.
  exports: [SessionsRepository, ApiKeyGuard],
})
export class CheckoutModule {}
