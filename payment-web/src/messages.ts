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
    sessionExpired: 'This checkout session has expired. Please start a new reservation.',
    sessionAlreadyProcessed: 'This payment has already been completed. Refresh to see the result.',
    invalidCardFormat: `Card must be 13-19 digits ending in ${CARD_LAST4.SUCCESS} (success) or ${CARD_LAST4.FAILURE} (failure).`,
    networkError: 'Could not reach the payment service. Check your connection and try again.',
    paymentRequestFailed: 'Payment failed. Please try again.',
    seatPrefix: 'Seat:',
    amountPrefix: 'Amount:',
  },
  result: {
    success: 'Payment ✓ Successful',
    failed: 'Payment ✗ Failed',
    successDetail: 'Your seat has been reserved.',
    successPendingDetail:
      'Your card was charged, but confirmation with the reservation system is still in progress. Your seat will appear as reserved shortly — please refresh in a few seconds.',
    failedDetail: 'Your payment could not be processed.',
    failedPendingDetail:
      'Your card was declined, but releasing the seat is still in progress. The seat will become available again shortly.',
    backButton: 'Back To Seat Reservation',
  },
} as const;
