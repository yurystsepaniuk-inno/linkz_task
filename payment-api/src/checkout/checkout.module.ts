import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { SessionsRepository } from './sessions.repository';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { CheckoutSessionExpiryRepository } from './checkout-session-expiry.repository';
import { PollRateLimitGuard } from './poll-rate-limit.guard';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { CheckoutSessionExpirySweeper } from './checkout-session-expiry.sweeper';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule provides ApiKeyGuard for the service-to-service endpoints
  // (`POST /sessions` and `GET /:id/status`).
  imports: [AuthModule],
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    SessionsRepository,
    WebhookDeliveryRepository,
    CheckoutSessionExpiryRepository,
    PollRateLimitGuard,
    WebhookDeliveryService,
    // Background cron that flips abandoned PENDING sessions to EXPIRED once
    // their 30-minute TTL elapses — keeps ops queries against `status` honest.
    CheckoutSessionExpirySweeper,
  ],
  // Re-export so sibling modules (RefundsModule) can read the session
  // lifecycle without re-providing.
  exports: [SessionsRepository],
})
export class CheckoutModule {}
