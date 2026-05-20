import { CARD_LAST4 } from './constants';

export const MESSAGES = {
  auth: {
    invalidApiKey: 'Invalid or missing API key',
  },
  sessions: {
    notFound: 'Session not found',
    alreadyProcessed: 'Session has already been processed',
    expired: 'Session has expired',
  },
  payment: {
    invalidCardFormat:
      'cardNumber must be 13-19 digits, optionally separated by spaces or dashes',
    invalidCardLast4: `Card must end in ${CARD_LAST4.SUCCESS} (success) or ${CARD_LAST4.FAILURE} (failure)`,
  },
} as const;
