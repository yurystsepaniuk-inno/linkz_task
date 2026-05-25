import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CheckoutSessionExpiryRepository } from './checkout-session-expiry.repository';
import { withSpan } from '../observability/tracer';
import { checkoutSessionsExpiredTotal } from '../observability/metrics';

/**
 * Transitions `checkout_sessions` rows from PENDING → EXPIRED once the
 * 30-minute TTL on `expires_at` has elapsed. Without this sweep, abandoned
 * PENDING rows accumulate forever and pollute ops queries like
 * `SELECT * FROM checkout_sessions WHERE status='PENDING'` — making it
 * impossible to tell genuinely in-flight checkouts apart from old debris.
 *
 * Pairs with the partial index `checkout_sessions_expiry_idx` on
 * `(expires_at) WHERE status='PENDING'`, which keeps the sweep cheap by
 * only indexing rows the sweep actually targets.
 *
 * **Defense in depth, not a single source of truth.** `SessionsRepository.tryClaim`
 * still gates its UPDATE on `status='PENDING' AND expires_at > NOW()`, so a
 * session whose TTL has passed but hasn't yet been swept is still rejected on
 * the hot path. This sweep is the *eventually consistent* half of the same
 * guarantee — it ensures the row's persisted status eventually matches what
 * the gating logic already enforces.
 *
 * **Idempotent.** Running mid-tick is safe: the WHERE clause matches only
 * still-PENDING rows past their expiry. Rows already swept are EXPIRED and
 * filtered out.
 */
@Injectable()
export class CheckoutSessionExpirySweeper {
  private readonly logger = new Logger(CheckoutSessionExpirySweeper.name);

  constructor(private readonly repo: CheckoutSessionExpiryRepository) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireStaleSessions(): Promise<number> {
    return withSpan('cron.checkout_session_expiry', {}, async (span) => {
      const swept = await this.repo.expireStale();
      span.setAttribute('sessions.swept', swept);
      if (swept > 0) {
        this.logger.log(`Expired ${swept} stale checkout session(s)`);
        checkoutSessionsExpiredTotal.add(swept);
      }
      return swept;
    });
  }
}
