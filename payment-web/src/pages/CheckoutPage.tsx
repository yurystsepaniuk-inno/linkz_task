import { useState, useEffect, FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PaymentResult } from '../constants';
import { MESSAGES } from '../messages';

const API_URL = import.meta.env.VITE_API_URL;
if (!API_URL) throw new Error('VITE_API_URL is required');

interface SessionData {
  seatId: string;
  amount: number;
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
    try {
      const res = await fetch(`${API_URL}/api/checkout/sessions/${sessionId}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardNumber }),
      });
      if (!res.ok) throw new Error(MESSAGES.checkout.paymentRequestFailed);
      const data = (await res.json()) as { status: PaymentResult };
      navigate(`/result?status=${data.status}`);
    } catch {
      setError(MESSAGES.checkout.paymentRequestFailed);
    } finally {
      setPaying(false);
    }
  }

  if (error) {
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
        <button type="submit" disabled={paying} data-testid="pay-button" className="button">
          {paying ? MESSAGES.checkout.paying : MESSAGES.checkout.pay}
        </button>
      </form>
    </div>
  );
}
