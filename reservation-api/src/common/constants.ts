export const SEAT_STATUS = {
  AVAILABLE: 'AVAILABLE',
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
} as const;
export type SeatStatus = (typeof SEAT_STATUS)[keyof typeof SEAT_STATUS];

export const RESERVATION_STATUS = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
} as const;
export type ReservationStatus = (typeof RESERVATION_STATUS)[keyof typeof RESERVATION_STATUS];

export const PAYMENT_EVENT = {
  SUCCEEDED: 'payment.succeeded',
  FAILED: 'payment.failed',
} as const;
export type PaymentEvent = (typeof PAYMENT_EVENT)[keyof typeof PAYMENT_EVENT];

export const ERROR_CODE = {
  SEAT_ALREADY_OCCUPIED: 'SEAT_ALREADY_OCCUPIED',
} as const;

// Append-only payment audit ledger (`payment_transactions`). `event_type` says
// *what kind* of payment event occurred; `outcome` says *what happened* to it.
export const AUDIT_EVENT = {
  CHECKOUT_SESSION_CREATED: 'CHECKOUT_SESSION_CREATED',
  WEBHOOK_RECEIVED: 'WEBHOOK_RECEIVED',
  PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  SIGNATURE_REJECTED: 'SIGNATURE_REJECTED',
  // Same (session_id, event_type) seen again — retry from the payment-api
  // reached us after the first attempt already committed. Recorded so the
  // ledger explicitly shows the redundancy rather than just a NOOP.
  DUPLICATE_WEBHOOK: 'DUPLICATE_WEBHOOK',
  RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
  // Reconciliation cron found a charged session whose seat was never
  // confirmed (webhook lost, payment-api retries exhausted, …) and asked
  // payment-api for a refund. Outcome SUCCESS = refund accepted; FAILED =
  // payment-api rejected (e.g. session not actually PAID).
  REFUND_INITIATED: 'REFUND_INITIATED',
  // Reconciliation cron looked at an orphan and concluded no refund is
  // owed (payment-api status was FAILED, or PENDING beyond the upper-bound
  // age). Recorded so the orphan SELECT excludes it on subsequent ticks —
  // without this, every non-PAID orphan would re-enter the candidate set
  // every 5 minutes and the working set would grow without bound.
  RECONCILIATION_DISMISSED: 'RECONCILIATION_DISMISSED',
} as const;
export type AuditEvent = (typeof AUDIT_EVENT)[keyof typeof AUDIT_EVENT];

export const AUDIT_OUTCOME = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  REJECTED: 'REJECTED',
  NOOP: 'NOOP', // event accepted but it changed no state (stale/duplicate webhook)
} as const;
export type AuditOutcome = (typeof AUDIT_OUTCOME)[keyof typeof AUDIT_OUTCOME];

export const SIGNATURE_HEADER = 'x-signature';
export const API_KEY_HEADER = 'x-api-key';

export const RESERVATION_LOCK_TTL_MINUTES = 5;

// Reconciliation grace window: how long an EXPIRED/FAILED reservation has
// to "settle" before the reconciliation cron will ask payment-api whether
// the charge actually went through. Longer than the seat-expiry TTL so the
// happy webhook path has every chance to land first.
export const RECONCILIATION_GRACE_MINUTES = 10;

// Upper bound for treating a PENDING payment-api session as "stuck". A
// well-behaved checkout reaches PAID or FAILED quickly; one still PENDING
// after this many hours is effectively abandoned and gets a
// RECONCILIATION_DISMISSED audit row so it drops out of the orphan set.
export const RECONCILIATION_PENDING_MAX_AGE_HOURS = 24;
