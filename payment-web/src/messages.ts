import { CARD_LAST4 } from './constants';

export const MESSAGES = {
  checkout: {
    title: 'Payment Checkout',
    cardLabel: 'Card Number',
    cardPlaceholder: `xxxx-xxxx-xxxx-${CARD_LAST4.SUCCESS}`,
    cardHint: `Use card ending in ${CARD_LAST4.SUCCESS} for success, ${CARD_LAST4.FAILURE} for failure.`,
    pay: 'Pay',
    paying: 'Processing…',
    loading: 'Loading…',
    sessionNotFound: 'Session not found or expired',
    paymentRequestFailed: 'Payment failed. Please try again.',
    seatPrefix: 'Seat:',
    amountPrefix: 'Amount:',
  },
  result: {
    success: 'Payment ✓ Successful',
    failed: 'Payment ✗ Failed',
    successDetail: 'Your seat has been reserved.',
    failedDetail: 'Your payment could not be processed.',
    backButton: 'Back To Seat Reservation',
  },
} as const;
