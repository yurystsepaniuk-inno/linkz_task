export const PAYMENT_EVENT = {
  SUCCEEDED: 'payment.succeeded',
  FAILED: 'payment.failed',
} as const;
export type PaymentEvent = (typeof PAYMENT_EVENT)[keyof typeof PAYMENT_EVENT];

export const SESSION_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
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
