import { MESSAGES, PAYMENT_ERROR_CODE } from '../consts';

/**
 * Map a backend error to a specific user-facing message. Routes on the
 * machine-readable `code` field that payment-api ships in the error body
 * (PAYMENT_ERROR_CODE.*) so changing the human-readable message text on the
 * server can never break this branching. Falls back to HTTP status only when
 * the body is unreadable or missing a code.
 */
export async function classifyError(res: Response | null): Promise<string> {
  if (!res) return MESSAGES.checkout.networkError;

  let code: string | undefined;
  try {
    const body = (await res.clone().json()) as { code?: string };
    code = body.code;
  } catch {
    // Non-JSON body or read error — fall through to status-based mapping.
  }

  switch (code) {
    case PAYMENT_ERROR_CODE.SESSION_NOT_FOUND:
      return MESSAGES.checkout.sessionExpired;
    case PAYMENT_ERROR_CODE.SESSION_ALREADY_PROCESSED:
      return MESSAGES.checkout.sessionAlreadyProcessed;
    case PAYMENT_ERROR_CODE.INVALID_CARD_FORMAT:
      return MESSAGES.checkout.invalidCardFormat;
  }

  if (res.status === 404) return MESSAGES.checkout.sessionExpired;
  if (res.status === 400) return MESSAGES.checkout.invalidCardFormat;
  return MESSAGES.checkout.paymentRequestFailed;
}
