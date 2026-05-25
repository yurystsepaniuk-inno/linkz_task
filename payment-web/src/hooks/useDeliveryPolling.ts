import { useEffect, useRef, useState } from 'react';
import { DELIVERY_STATUS, POLL_BASE_MS, POLL_TIMEOUT_MS } from '../consts';
import { nextDelay } from '../helpers';
import { checkoutService } from '../services';

interface UseDeliveryPolling {
  delivered: boolean;
  pollExhausted: boolean;
}

/**
 * Polls payment-api's delivery-status endpoint until the webhook for this
 * session is reported as terminally delivered or failed. Lets the result
 * page clear its "sync in progress…" banner without forcing the buyer to
 * refresh. No-ops if the session has already been confirmed (initialDelivered)
 * or no sessionId is known.
 */
export function useDeliveryPolling(
  sessionId: string | null,
  initialDelivered: boolean,
): UseDeliveryPolling {
  const [delivered, setDelivered] = useState(initialDelivered);
  const [pollExhausted, setPollExhausted] = useState(false);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (delivered || !sessionId) return;
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
      // A 429 (rate-limited) returns null here; we fall through to the
      // backoff step rather than crashing, so the next tick fires later.
      const body = await checkoutService.getDeliveryStatus(sessionId).catch(() => null);
      if (body) {
        if (body.terminalDelivered) {
          setDelivered(true);
          return;
        }
        if (body.status === DELIVERY_STATUS.FAILED) {
          setPollExhausted(true);
          return;
        }
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

  return { delivered, pollExhausted };
}
