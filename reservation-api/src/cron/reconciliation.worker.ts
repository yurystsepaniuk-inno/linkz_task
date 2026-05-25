import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  AUDIT_EVENT,
  AUDIT_OUTCOME,
  API_KEY_HEADER,
  RECONCILIATION_PENDING_MAX_AGE_HOURS,
  REFUND_MAX_ATTEMPTS,
} from '../common/constants';
import { PaymentAuditRepository } from '../audit/payment-audit.repository';
import {
  ReconciliationRepository,
  OrphanedReservation,
} from './reconciliation.repository';
import { fetchWithTimeout } from '../common/http';
import { withSpan } from '../observability/tracer';
import { reconciliationRefundsTotal } from '../observability/metrics';

/**
 * Reconciliation cron: closes the loop between reservation-api and payment-api
 * when the webhook path is lost.
 *
 * The webhook is the *fast* path — when payment-api succeeds it POSTs us and
 * we mark the reservation CONFIRMED in under a second. But every microservice
 * boundary leaks: payment-api could exhaust its 5 retries while we are down,
 * the webhook could be HMAC-rejected at our edge, or a row's status update
 * could roll back after the charge committed on payment-api's side. In all
 * of those, the seat ends up EXPIRED/FAILED but the user was charged.
 *
 * This worker is the *slow* path. Every 5 minutes it asks: "are there any
 * reservations we gave up on, where the corresponding session on payment-api
 * actually got paid?" If yes, it asks payment-api for a refund (idempotent on
 * session_id). On success it writes one REFUND_INITIATED row to the audit
 * ledger (terminal — the orphan gate excludes it forever after). On failure
 * it writes a *non-terminal* REFUND_ATTEMPT_FAILED row so the same orphan
 * gets retried on the next tick. After REFUND_MAX_ATTEMPTS failures it
 * writes a terminal REFUND_GAVE_UP row to stop looping and surface the
 * stuck session via `reconciliation_refunds_total{outcome="gave_up"}`.
 *
 * Grace window: a fresh expiry might still have a webhook in flight. We wait
 * `RECONCILIATION_GRACE_MINUTES` (longer than the seat-lock TTL) before
 * touching anything so the happy path always wins.
 */
interface SessionStatusResponse {
  sessionId: string;
  status: 'PENDING' | 'PAID' | 'FAILED';
  seatId: string;
  userId: string;
  amount: number;
}

@Injectable()
export class ReconciliationWorker {
  private readonly logger = new Logger(ReconciliationWorker.name);

  constructor(
    private readonly repo: ReconciliationRepository,
    private readonly audit: PaymentAuditRepository,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileOrphanedPayments() {
    return withSpan('cron.reconciliation', {}, async (span) => {
      const orphans = await this.repo.findOrphanedReservations();
      span.setAttribute('reconciliation.candidates', orphans.length);
      if (orphans.length === 0) return;

      this.logger.log(`Reconciliation: ${orphans.length} candidate reservation(s)`);
      for (const row of orphans) {
        await this.reconcileOne(row).catch((err) =>
          this.logger.error(`Reconciliation failed for reservation ${row.id}`, err),
        );
      }
    });
  }

  private async reconcileOne(row: OrphanedReservation): Promise<void> {
    const session = await this.fetchSessionStatus(row.session_id);
    if (!session) return; // payment-api unreachable or 404 — try again next tick

    // FAILED: charge never went through; no money moved; no refund owed.
    //   Write RECONCILIATION_DISMISSED so this orphan stops re-entering the
    //   candidate set on every tick — otherwise the working set grows
    //   unbounded for every abandoned/failed checkout.
    // PENDING: still in flight on the payment side; the webhook may yet
    //   arrive. Leave it alone — UNLESS the reservation is older than
    //   RECONCILIATION_PENDING_MAX_AGE_HOURS, in which case the session is
    //   effectively stuck and we dismiss it too.
    // PAID: the user was charged but we have no CONFIRMED reservation —
    //   refund.
    if (session.status === 'FAILED') {
      await this.dismiss(row, session, 'payment-api status FAILED — no refund owed');
      return;
    }
    if (session.status === 'PENDING') {
      const ageHours =
        (Date.now() - row.created_at.getTime()) / (60 * 60 * 1000);
      if (ageHours > RECONCILIATION_PENDING_MAX_AGE_HOURS) {
        await this.dismiss(
          row,
          session,
          `payment-api status PENDING beyond ${RECONCILIATION_PENDING_MAX_AGE_HOURS}h — treating as abandoned`,
        );
      }
      return;
    }

    const refund = await this.requestRefund(row.session_id);

    if (refund.ok) {
      // `dedupeBySession: true` — the `NOT EXISTS` candidate gate dedupes
      // across cron ticks (once a REFUND_INITIATED row exists, the orphan
      // SELECT no longer returns this session). It does NOT dedupe two
      // replicas in the *same* tick: both gates pass while neither audit
      // row is written yet, both proceed to refund, and both then try to
      // write. The partial unique index `ux_refund_initiated_one_per_session`
      // plus ON CONFLICT DO NOTHING make the loser's INSERT a no-op, so the
      // ledger gets exactly one REFUND_INITIATED row per session — matching
      // the single refund payment-api actually issued (refunds there are
      // idempotent on session_id).
      await this.audit.record(
        {
          eventType: AUDIT_EVENT.REFUND_INITIATED,
          outcome: AUDIT_OUTCOME.SUCCESS,
          reservationId: row.id,
          sessionId: row.session_id,
          seatId: row.seat_id,
          userId: row.user_id,
          amount: session.amount,
          rawPayload: {
            reason: 'orphaned PAID session — seat never confirmed',
            refundResponse: refund.body,
          },
        },
        undefined,
        { dedupeBySession: true },
      );

      reconciliationRefundsTotal.add(1, { outcome: 'initiated' });
      this.logger.log(
        `Refund initiated for reservation ${row.id} (session ${row.session_id})`,
      );
      return;
    }

    // Failure branch — write a *non-terminal* REFUND_ATTEMPT_FAILED row so
    // the orphan SELECT still returns this session on the next tick and we
    // retry. The previous implementation wrote REFUND_INITIATED with
    // outcome=FAILED here, which the orphan gate treated as terminal and
    // suppressed every future retry — a transient 502 or network blip
    // meant the user was charged but never refunded.
    const priorFailures = await this.audit.countByEvent(
      row.session_id,
      AUDIT_EVENT.REFUND_ATTEMPT_FAILED,
    );
    const attemptNumber = priorFailures + 1;
    const gaveUp = attemptNumber >= REFUND_MAX_ATTEMPTS;

    await this.audit.record({
      eventType: gaveUp ? AUDIT_EVENT.REFUND_GAVE_UP : AUDIT_EVENT.REFUND_ATTEMPT_FAILED,
      outcome: AUDIT_OUTCOME.FAILED,
      reservationId: row.id,
      sessionId: row.session_id,
      seatId: row.seat_id,
      userId: row.user_id,
      amount: session.amount,
      rawPayload: {
        reason: 'orphaned PAID session — refund attempt failed',
        attemptNumber,
        maxAttempts: REFUND_MAX_ATTEMPTS,
        refundResponse: refund.body,
      },
    });

    reconciliationRefundsTotal.add(1, {
      outcome: gaveUp ? 'gave_up' : 'failed',
    });

    if (gaveUp) {
      this.logger.error(
        `Refund GAVE UP for reservation ${row.id} (session ${row.session_id}) ` +
          `after ${attemptNumber} attempts — operator action required: ${JSON.stringify(refund.body)}`,
      );
    } else {
      this.logger.warn(
        `Refund attempt ${attemptNumber}/${REFUND_MAX_ATTEMPTS} failed for ` +
          `reservation ${row.id} (session ${row.session_id}); will retry next tick: ` +
          `${JSON.stringify(refund.body)}`,
      );
    }
  }

  /**
   * Write a terminal RECONCILIATION_DISMISSED audit row so the orphan
   * SELECT's `NOT EXISTS` gate excludes this session on the next tick. No
   * dedupe option here: even if two replicas race and write twice, both
   * rows mean the same thing (no refund owed) and the gate still works.
   */
  private async dismiss(
    row: OrphanedReservation,
    session: SessionStatusResponse,
    reason: string,
  ): Promise<void> {
    await this.audit.record({
      eventType: AUDIT_EVENT.RECONCILIATION_DISMISSED,
      outcome: AUDIT_OUTCOME.NOOP,
      reservationId: row.id,
      sessionId: row.session_id,
      seatId: row.seat_id,
      userId: row.user_id,
      amount: session.amount,
      rawPayload: { reason, paymentSessionStatus: session.status },
    });
    this.logger.log(
      `Reconciliation dismissed reservation ${row.id} (${reason})`,
    );
  }

  private async fetchSessionStatus(
    sessionId: string,
  ): Promise<SessionStatusResponse | null> {
    const paymentApiUrl = this.config.getOrThrow<string>('PAYMENT_API_URL');
    const paymentApiKey = this.config.getOrThrow<string>('PAYMENT_API_KEY');
    try {
      const res = await fetchWithTimeout(
        `${paymentApiUrl}/api/checkout/sessions/${encodeURIComponent(sessionId)}/status`,
        { headers: { [API_KEY_HEADER]: paymentApiKey } },
      );
      if (!res.ok) {
        this.logger.warn(`payment-api status ${res.status} for session ${sessionId}`);
        return null;
      }
      const body = await this.readJsonOrTrace(res, `session ${sessionId} status`);
      // If parsing failed we got a `{ parseError, rawText }` trace object,
      // not a real SessionStatusResponse. We can't trust the status field —
      // skip this tick. The diagnostic was already logged by readJsonOrTrace.
      if (!isSessionStatusResponse(body)) return null;
      return body;
    } catch (err) {
      this.logger.error(`payment-api status lookup failed for ${sessionId}`, err);
      return null;
    }
  }

  private async requestRefund(
    sessionId: string,
  ): Promise<{ ok: boolean; body: unknown }> {
    const paymentApiUrl = this.config.getOrThrow<string>('PAYMENT_API_URL');
    const paymentApiKey = this.config.getOrThrow<string>('PAYMENT_API_KEY');
    try {
      const res = await fetchWithTimeout(`${paymentApiUrl}/api/refunds`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [API_KEY_HEADER]: paymentApiKey,
        },
        body: JSON.stringify({
          sessionId,
          reason: 'reconciliation: orphaned PAID session',
        }),
      });
      // Keep the raw text on parse failure (e.g. proxy HTML error page)
      // instead of swallowing it to `null` — the audit ledger's rawPayload
      // is the only place that diagnostic survives, and "refund failed,
      // body: null" is unhelpful at 3am when you're trying to figure out
      // whether a Stripe outage or a misrouted request was responsible.
      const body = await this.readJsonOrTrace(res, `refund for session ${sessionId}`);
      return { ok: res.ok, body };
    } catch (err) {
      return { ok: false, body: { error: (err as Error).message } };
    }
  }

  /**
   * Read a `fetch` response as text first, then attempt JSON parse. On
   * parse failure, return a structured trace `{ parseError, httpStatus,
   * rawText }` instead of `null` — the raw text (truncated to 2000 chars)
   * is captured in the audit row's `rawPayload` so post-incident review
   * can see what the upstream actually returned. The previous
   * `.catch(() => null)` destroyed exactly this information.
   *
   * Logs a `warn` line when the body wasn't JSON so failures surface in the
   * log stream even when nobody pulls the audit row by hand.
   */
  private async readJsonOrTrace(res: Response, context: string): Promise<unknown> {
    const text = await res.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      this.logger.warn(
        `payment-api returned non-JSON for ${context} (HTTP ${res.status}): ${text.slice(0, 500)}`,
      );
      return {
        parseError: (err as Error).message,
        httpStatus: res.status,
        rawText: text.slice(0, 2000),
      };
    }
  }
}

/**
 * Minimal structural check for the payment-api `/sessions/:id/status`
 * response. We don't want a parse-trace object (with `parseError` instead
 * of `status`) to slip past as if it were a real status — the rest of
 * `reconcileOne` switches on `session.status` and would silently take the
 * wrong branch.
 */
function isSessionStatusResponse(value: unknown): value is SessionStatusResponse {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === 'string' &&
    (v.status === 'PENDING' || v.status === 'PAID' || v.status === 'FAILED') &&
    typeof v.seatId === 'string' &&
    typeof v.userId === 'string' &&
    typeof v.amount === 'number'
  );
}
