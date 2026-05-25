import { useState, useEffect, FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PAYMENT_ERROR_CODE, PaymentResult } from '../constants';
import { MESSAGES } from '../messages';

const API_URL = import.meta.env.VITE_API_URL;
if (!API_URL) throw new Error('VITE_API_URL is required');

interface SessionData {
  seatId: string;
  amount: number;
}

interface PayResponse {
  status: PaymentResult;
  webhookDelivered: boolean;
}

/**
 * Map a backend error to a specific user-facing message. Routes on the
 * machine-readable `code` field that payment-api ships in the error body
 * (PAYMENT_ERROR_CODE.*) so changing the human-readable message text on the
 * server can never break this branching. Falls back to HTTP status only when
 * the body is unreadable or missing a code.
 */
async function classifyError(res: Response | null): Promise<string> {
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

export default function CheckoutPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/checkout/sessions/${sessionId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(MESSAGES.checkout.sessionNotFound);
        return res.json() as Promise<SessionData>;
      })
      .then(setSession)
      .catch(() => setError(MESSAGES.checkout.sessionNotFound));
  }, [sessionId]);

  async function handlePay(e: FormEvent) {
    e.preventDefault();
    setPaying(true);
    setError('');
    let res: Response | null = null;
    try {
      res = await fetch(`${API_URL}/api/checkout/sessions/${sessionId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardNumber }),
      });
      if (!res.ok) {
        setError(await classifyError(res));
        return;
      }
      const data = (await res.json()) as PayResponse;
      // Pass the webhook-delivery flag and the session id through to the
      // result page so the UI can tell the user "your seat is still being
      // confirmed" *and* poll the delivery-status endpoint to clear that
      // banner the moment reservation-api receives the event.
      const delivered = data.webhookDelivered ? '1' : '0';
      const search = new URLSearchParams({
        status: data.status,
        delivered,
        sessionId: sessionId ?? '',
      });
      navigate(`/result?${search.toString()}`);
    } catch {
      // network/CORS/abort — no Response at all
      setError(await classifyError(null));
    } finally {
      setPaying(false);
    }
  }

  if (error && !session) {
    return (
      <div className="page">
        <p data-testid="checkout-error" className="error-text">{error}</p>
      </div>
    );
  }

  if (!session) {
    return <div className="page">{MESSAGES.checkout.loading}</div>;
  }

  return (
    <div className="page">
      <h1>{MESSAGES.checkout.title}</h1>
      <p data-testid="seat-id">{MESSAGES.checkout.seatPrefix} <strong>{session.seatId}</strong></p>
      <p data-testid="amount">{MESSAGES.checkout.amountPrefix} <strong>${session.amount.toFixed(2)}</strong></p>
      <form onSubmit={handlePay}>
        <div className="form-field">
          <label>{MESSAGES.checkout.cardLabel}<br />
            <input
              type="text"
              value={cardNumber}
              onChange={(e) => setCardNumber(e.target.value)}
              placeholder={MESSAGES.checkout.cardPlaceholder}
              required
              className="form-field__input"
              data-testid="card-input"
            />
          </label>
        </div>
        <p className="hint-text">{MESSAGES.checkout.cardHint}</p>
        {error && (
          <p data-testid="checkout-error" className="error-text">{error}</p>
        )}
        <button type="submit" disabled={paying} data-testid="pay-button" className="button">
          {paying ? MESSAGES.checkout.paying : MESSAGES.checkout.pay}
        </button>
      </form>
    </div>
  );
}
