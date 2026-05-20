export const PAYMENT_RESULT = {
  SUCCESS: 'success',
  FAILED: 'failed',
} as const;
export type PaymentResult = (typeof PAYMENT_RESULT)[keyof typeof PAYMENT_RESULT];

export const CARD_LAST4 = {
  SUCCESS: '4000',
  FAILURE: '5000',
} as const;
