export const SEAT_STATUS = {
  AVAILABLE: 'AVAILABLE',
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
} as const;
export type SeatStatus = (typeof SEAT_STATUS)[keyof typeof SEAT_STATUS];

export const PAYMENT_EVENT = {
  SUCCEEDED: 'payment.succeeded',
  FAILED: 'payment.failed',
} as const;
export type PaymentEvent = (typeof PAYMENT_EVENT)[keyof typeof PAYMENT_EVENT];

export const ERROR_CODE = {
  SEAT_ALREADY_OCCUPIED: 'SEAT_ALREADY_OCCUPIED',
} as const;

export const SIGNATURE_HEADER = 'x-signature';

export const RESERVATION_LOCK_TTL_MINUTES = 5;
export const JWT_EXPIRES_IN = '90d';
