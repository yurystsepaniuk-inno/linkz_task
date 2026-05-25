/**
 * Application metrics for payment-api.
 *
 *   • payment_attempts_total{result}         — success / failed / rejected (per `pay()` call)
 *   • payment_request_duration_seconds       — p95 latency histogram for /pay
 *   • webhook_delivery_attempts_total{outcome} — sent / failed / retried
 *   • webhook_delivery_final_total{outcome}    — DELIVERED / FAILED (terminal)
 *   • checkout_sessions_expired_total          — sweeper output
 *   • refund_requests_total{outcome}           — REFUNDED / FAILED
 *
 * Safe in tests: no-op meter when no SDK is registered.
 */
import { metrics, ValueType, Histogram, Attributes } from '@opentelemetry/api';

const meter = metrics.getMeter('payment-api', '1.0.0');

export const paymentAttemptsTotal = meter.createCounter('payment_attempts_total', {
  description:
    'POST /api/checkout/sessions/:id/pay outcomes. Drives the payment-side ' +
    'half of the payment-success SLI.',
});

export const paymentRequestDuration = meter.createHistogram(
  'payment_request_duration_seconds',
  {
    description: 'Server-side latency of the pay() endpoint.',
    valueType: ValueType.DOUBLE,
    unit: 's',
  },
);

export const webhookDeliveryAttemptsTotal = meter.createCounter(
  'webhook_delivery_attempts_total',
  {
    description:
      'Every webhook attempt (success or failure). The retry loop fires this ' +
      'once per HTTP call — `outcome` distinguishes sent / failed / retried.',
  },
);

export const webhookDeliveryFinalTotal = meter.createCounter(
  'webhook_delivery_final_total',
  {
    description:
      'Terminal outcome of a webhook delivery — DELIVERED (≥1 attempt 2xx) ' +
      'or FAILED (all retries exhausted). Drives the webhook delivery SLI.',
  },
);

export const checkoutSessionsExpiredTotal = meter.createCounter(
  'checkout_sessions_expired_total',
  { description: 'Sessions swept PENDING→EXPIRED by the every-minute cron.' },
);

export const refundRequestsTotal = meter.createCounter('refund_requests_total', {
  description: 'Refund-API request outcomes (REFUNDED / FAILED / duplicate-noop).',
});

/** See `reservation-api/src/observability/metrics.ts` for the shared rationale. */
export function recordDuration(
  hist: Histogram,
  startedHrTimeNs: bigint,
  attrs: Attributes = {},
): void {
  const elapsedNs = Number(process.hrtime.bigint() - startedHrTimeNs);
  hist.record(elapsedNs / 1e9, attrs);
}
