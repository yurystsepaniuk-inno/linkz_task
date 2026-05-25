import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PAYMENT_RESULT } from '../constants';
import { MESSAGES } from '../messages';

const RESERVATION_WEB_URL = import.meta.env.VITE_RESERVATION_WEB_URL;
if (!RESERVATION_WEB_URL) throw new Error('VITE_RESERVATION_WEB_URL is required');
const API_URL = import.meta.env.VITE_API_URL;
if (!API_URL) throw new Error('VITE_API_URL is required');

/** Polling cadence — exponential backoff so a fast-settling delivery feels
 *  snappy while a stuck one doesn't hammer the unauthenticated endpoint.
 *  Sequence: 1500, 2250, 3375, 5062, 7593, 10000, 10000…ms (clamped).
 *  Over the 5-minute timeout that's ~33 requests, comfortably under the
 *  120/min per-IP server cap even with several browser tabs open. */
const POLL_BASE_MS = 1500;
const POLL_MAX_MS = 10_000;
const POLL_BACKOFF_FACTOR = 1.5;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function nextDelay(prev: number): number {
  return Math.min(Math.round(prev * POLL_BACKOFF_FACTOR), POLL_MAX_MS);
}

type DeliveryStatusBody = {
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  terminalDelivered: boolean;
};

/**
 * Four-way result rendering: outcome × webhook-delivery. The previous version
 * dead-ended on "sync in progress…" with no way out — even after retries
 * succeeded the banner stayed up because the page never re-checked. We now
 * poll the payment-api delivery-status endpoint until it reports DELIVERED
 * (or FAILED), so the banner clears the moment reservation-api receives the
 * event without forcing the buyer to refresh.
 */
export default function ResultPage() {
  const [params] = useSearchParams();
  const status = params.get('status') || 'unknown';
  const sessionId = params.get('sessionId');
  const initialDelivered = params.get('delivered') !== '0';
  const isSuccess = status === PAYMENT_RESULT.SUCCESS;

  const [delivered, setDelivered] = useState(initialDelivered);
  const [pollExhausted, setPollExhausted] = useState(false);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (delivered || !sessionId) return; // already confirmed, or no session to poll
    let cancelled = false;
    // Track the current delay so each tick can schedule itself at the next
    // backoff step. Stored in the closure (not state) because we don't want a
    // re-render per tick.
    let delay = POLL_BASE_MS;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt.current > POLL_TIMEOUT_MS) {
        setPollExhausted(true);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/api/checkout/sessions/${sessionId}/delivery-status`);
        if (res.ok) {
          const body = (await res.json()) as DeliveryStatusBody;
          if (body.terminalDelivered) {
            setDelivered(true);
            return; // stop polling on success
          }
          if (body.status === 'FAILED') {
            setPollExhausted(true);
            return; // stop polling — delivery is permanently dead
          }
        }
        // A 429 (rate-limited) lands here as !res.ok; we fall through to the
        // backoff step rather than crashing, so the next tick fires later.
      } catch {
        // Network blip — keep polling; the timeout cap catches a hung backend.
      }
      if (!cancelled) {
        delay = nextDelay(delay);
        setTimeout(tick, delay);
      }
    };
    const timer = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [delivered, sessionId]);

  const heading = isSuccess ? MESSAGES.result.success : MESSAGES.result.failed;
  const detail = isSuccess
    ? delivered
      ? MESSAGES.result.successDetail
      : MESSAGES.result.successPendingDetail
    : delivered
      ? MESSAGES.result.failedDetail
      : MESSAGES.result.failedPendingDetail;

  return (
    <div className="page page--centered">
      <h1 data-testid="result-status">{heading}</h1>
      <p data-testid="result-detail">{detail}</p>
      {!delivered && !pollExhausted && (
        <p data-testid="result-pending" className="hint-text">
          Reservation system sync in progress…
        </p>
      )}
      {!delivered && pollExhausted && (
        <p data-testid="result-pending-exhausted" className="hint-text">
          The reservation system hasn’t confirmed yet. Refresh the seat page to
          check the latest status; our reconciliation cron will resolve any
          mismatch within a few minutes.
        </p>
      )}
      <a href={RESERVATION_WEB_URL} data-testid="back-button" className="button-link">
        {MESSAGES.result.backButton}
      </a>
    </div>
  );
}
