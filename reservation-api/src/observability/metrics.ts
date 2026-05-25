/**
 * Application metrics for reservation-api.
 *
 * These are the four SLIs the SLO dashboard tracks, plus a couple of operational
 * counters that aren't SLIs but matter for incident triage:
 *
 *   • reservations_total{outcome}     — confirmed / failed / conflict / expired
 *   • payment_outcomes_total{outcome} — succeeded / failed (from webhooks)
 *   • webhook_signature_rejected_total— SIGNATURE_REJECTED count (security signal)
 *   • reservation_request_duration_seconds — p95 latency histogram
 *   • reconciliation_refunds_total{outcome} — refund-initiated rate from the cron
 *   • seat_expiry_swept_total         — seats released by the every-minute sweeper
 *
 * Calls into these are safe even when the OTel SDK isn't running: `getMeter`
 * returns a no-op meter when no provider is registered, which is what tests
 * (and any process started with OTEL_DISABLED=1) depend on.
 */
import { metrics, ValueType, Histogram, Attributes } from '@opentelemetry/api';

const meter = metrics.getMeter('reservation-api', '1.0.0');

export const reservationsTotal = meter.createCounter('reservations_total', {
  description:
    'Reservation outcomes. The availability SLI is computed as ' +
    '(confirmed+conflict) / (confirmed+conflict+failed): 409 conflict is a ' +
    'valid business outcome, not an error.',
});

export const paymentOutcomesTotal = meter.createCounter('payment_outcomes_total', {
  description:
    'Payment results observed via webhook. Drives the payment-success SLI. ' +
    'Outcome labels: `succeeded` / `failed` (happy path), `duplicate` ' +
    '(payment-api retried a webhook we already settled), `noop_stale` ' +
    '(webhook matched no live reservation — payment-api side is settled, ' +
    'reconciliation cron will refund). Alert on noop_stale rate > 0 for any ' +
    'sustained window.',
});

export const webhookSignatureRejectedTotal = meter.createCounter(
  'webhook_signature_rejected_total',
  { description: 'HMAC-rejected inbound webhooks. Security signal — alert if > 0.' },
);

export const reservationDuration = meter.createHistogram(
  'reservation_request_duration_seconds',
  {
    description: 'Server-side latency of POST /api/reservations.',
    valueType: ValueType.DOUBLE,
    unit: 's',
  },
);

export const reconciliationRefundsTotal = meter.createCounter(
  'reconciliation_refunds_total',
  {
    description:
      'Refunds initiated by the reconciliation cron. A non-zero value means ' +
      'the webhook path failed for some session and the slow path picked up the slack.',
  },
);

export const seatExpirySweptTotal = meter.createCounter('seat_expiry_swept_total', {
  description: 'Stale PENDING_PAYMENT reservations released by the every-minute sweep.',
});

/**
 * Record elapsed seconds into a histogram, given a `process.hrtime.bigint()`
 * timestamp captured at the start of the operation. Centralized so every
 * call site picks the same unit (seconds, to match Prometheus convention on
 * `_seconds`-suffixed histogram names).
 */
export function recordDuration(
  hist: Histogram,
  startedHrTimeNs: bigint,
  attrs: Attributes = {},
): void {
  const elapsedNs = Number(process.hrtime.bigint() - startedHrTimeNs);
  hist.record(elapsedNs / 1e9, attrs);
}
