export const PAYMENT_EVENT = {
  SUCCEEDED: 'payment.succeeded',
  FAILED: 'payment.failed',
} as const;
export type PaymentEvent = (typeof PAYMENT_EVENT)[keyof typeof PAYMENT_EVENT];

// Checkout session lifecycle. PAID/FAILED are the terminal outcomes set by
// the buyer's `pay()` call; EXPIRED is the terminal state set by the
// `CheckoutSessionExpirySweeper` cron when a PENDING row's `expires_at`
// passes without the buyer ever paying. Splitting EXPIRED out from PENDING
// is what lets `SELECT * WHERE status='PENDING'` return only sessions that
// are *actually* in flight — without the sweep, abandoned PENDING rows pile
// up and the status field becomes useless to ops.
export const SESSION_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
} as const;
export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

export const PAYMENT_RESULT = {
  SUCCESS: 'success',
  FAILED: 'failed',
} as const;
export type PaymentResult = (typeof PAYMENT_RESULT)[keyof typeof PAYMENT_RESULT];

export const CARD_LAST4 = {
  SUCCESS: '4000',
  FAILURE: '5000',
} as const;

export const SIGNATURE_HEADER = 'x-signature';
export const API_KEY_HEADER = 'x-api-key';
export const SESSION_ID_PREFIX = 'sess_';

// Stable machine-readable error codes shipped in the response body alongside
// the human-readable `message`. Lets the frontend branch on a contract value
// instead of substring-matching the message text (which broke whenever copy
// changed). Keep these in sync with reservation-api's `ERROR_CODE`.
export const PAYMENT_ERROR_CODE = {
  INVALID_CARD_FORMAT: 'INVALID_CARD_FORMAT',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_ALREADY_PROCESSED: 'SESSION_ALREADY_PROCESSED',
  INVALID_API_KEY: 'INVALID_API_KEY',
} as const;
export type PaymentErrorCode = (typeof PAYMENT_ERROR_CODE)[keyof typeof PAYMENT_ERROR_CODE];

// Checkout-session TTL. The buyer has this long to submit a card after the
// session is created; any later `pay()` is rejected at the DB by the
// `expires_at > NOW()` filter in `SessionsRepository.tryClaim`, and the
// `CheckoutSessionExpirySweeper` cron then transitions abandoned PENDING
// rows to EXPIRED. Kept here (not env-driven) because the value is part of
// the checkout UX contract and shouldn't drift between environments.
export const SESSION_TTL_MS = 30 * 60 * 1000;

// Webhook delivery retry policy. The first attempt is synchronous; subsequent
// retries fire from a background timer with exponential backoff:
//   attempt 2 fires baseDelayMs after attempt 1,
//   attempt 3 fires 2*baseDelayMs after attempt 2,
//   attempt N fires 2^(N-2) * baseDelayMs after attempt N-1.
// With maxAttempts=5 and baseDelayMs=1000ms: ~15s total window.
export const WEBHOOK_DELIVERY = {
  maxAttempts: 5,
  baseDelayMs: 1000,
} as const;

export const DELIVERY_STATUS = {
  PENDING: 'PENDING', // attempts in flight; more retries scheduled
  DELIVERED: 'DELIVERED', // a fetch returned 2xx — reservation-api has the event
  FAILED: 'FAILED', // exhausted all attempts; reconciliation cron is the recovery
} as const;
export type DeliveryStatus = (typeof DELIVERY_STATUS)[keyof typeof DELIVERY_STATUS];

// A refund row in `refunds` (payment-api's own database). The mock provider settles refunds
// synchronously, so we only ever write REFUNDED on success — FAILED is
// reserved for a future async refund executor.
export const REFUND_STATUS = {
  REFUNDED: 'REFUNDED',
  FAILED: 'FAILED',
} as const;
export type RefundStatus = (typeof REFUND_STATUS)[keyof typeof REFUND_STATUS];
