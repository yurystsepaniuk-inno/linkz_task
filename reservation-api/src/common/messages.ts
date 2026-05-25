export const MESSAGES = {
  auth: {
    missingToken: 'Missing bearer token',
    invalidToken: 'Invalid or expired session token',
    verifierUnavailable: 'Authentication service unavailable',
  },
  webhooks: {
    invalidSignature: 'Invalid signature',
    unknownEvent: 'Unknown event',
  },
  reservations: {
    paymentApiError: 'Payment API error',
    paymentServiceUnavailable: 'Payment service unavailable',
    notFound: 'Reservation not found',
  },
} as const;
