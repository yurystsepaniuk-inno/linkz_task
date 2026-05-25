export const PAYMENT_RESULT = {
  SUCCESS: 'success',
  FAILED: 'failed',
} as const;

export type PaymentResult = (typeof PAYMENT_RESULT)[keyof typeof PAYMENT_RESULT];
