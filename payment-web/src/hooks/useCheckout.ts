import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MESSAGES } from '../consts';
import { classifyError } from '../helpers';
import { checkoutService } from '../services';
import type { SessionData } from '../types';

interface UseCheckout {
  sessionId: string | undefined;
  session: SessionData | null;
  error: string;
  cardNumber: string;
  paying: boolean;
  setCardNumber: (value: string) => void;
  handlePay: (e: FormEvent) => Promise<void>;
}

export function useCheckout(): UseCheckout {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionData | null>(null);
  const [error, setError] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    checkoutService
      .getSession(sessionId)
      .then(setSession)
      .catch(() => setError(MESSAGES.checkout.sessionNotFound));
  }, [sessionId]);

  async function handlePay(e: FormEvent) {
    e.preventDefault();
    if (!sessionId) return;
    setPaying(true);
    setError('');
    try {
      const result = await checkoutService.pay(sessionId, cardNumber);
      if (!result.ok) {
        setError(await classifyError(result.res));
        return;
      }
      // Pass the webhook-delivery flag and the session id through to the
      // result page so the UI can tell the user "your seat is still being
      // confirmed" *and* poll the delivery-status endpoint to clear that
      // banner the moment reservation-api receives the event.
      const search = new URLSearchParams({
        status: result.data.status,
        delivered: result.data.webhookDelivered ? '1' : '0',
        sessionId,
      });
      navigate(`/result?${search.toString()}`);
    } finally {
      setPaying(false);
    }
  }

  return {
    sessionId,
    session,
    error,
    cardNumber,
    paying,
    setCardNumber,
    handlePay,
  };
}
