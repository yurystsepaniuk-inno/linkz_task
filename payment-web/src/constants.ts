export const PAYMENT_RESULT = {
  SUCCESS: 'success',
  FAILED: 'failed',
} as const;
export type PaymentResult = (typeof PAYMENT_RESULT)[keyof typeof PAYMENT_RESULT];

export const CARD_LAST4 = {
  SUCCESS: '4000',
  FAILURE: '5000',
} as const;

// Mirrors `PAYMENT_ERROR_CODE` in payment-api/src/common/constants.ts. The
// backend ships these codes in the error body so the frontend can route on
// a contract value instead of substring-matching the human message.
export const PAYMENT_ERROR_CODE = {
  INVALID_CARD_FORMAT: 'INVALID_CARD_FORMAT',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_ALREADY_PROCESSED: 'SESSION_ALREADY_PROCESSED',
  INVALID_API_KEY: 'INVALID_API_KEY',
} as const;
export type PaymentErrorCode =
  (typeof PAYMENT_ERROR_CODE)[keyof typeof PAYMENT_ERROR_CODE];
