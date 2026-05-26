import { ENDPOINTS } from '../consts';
import type { DeliveryStatusBody, PayResponse, SessionData } from '../types';

const API_URL = import.meta.env.VITE_API_URL;
if (!API_URL) throw new Error('VITE_API_URL is required');

/**
 * Domain service over payment-api. Pages call these methods and stay
 * unaware of the URL shape or whether the transport is fetch/axios.
 *
 * `pay` returns a `{ ok: true, data }` or `{ ok: false, res }` discriminated
 * shape because the UI cares about both branches: 4xx bodies carry the
 * machine-readable error code that classifyError() routes on. `res` is `null`
 * for network/CORS errors where no Response exists at all.
 */
export type PayResult = { ok: true; data: PayResponse } | { ok: false; res: Response | null };

export const checkoutService = {
  async getSession(sessionId: string): Promise<SessionData> {
    const res = await fetch(`${API_URL}${ENDPOINTS.session(sessionId)}`);
    if (!res.ok) throw new Error('Session fetch failed');
    return (await res.json()) as SessionData;
  },

  async pay(sessionId: string, cardNumber: string): Promise<PayResult> {
    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.pay(sessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardNumber }),
      });
      if (!res.ok) return { ok: false, res };
      const data = (await res.json()) as PayResponse;
      return { ok: true, data };
    } catch {
      // network/CORS/abort — no Response at all
      return { ok: false, res: null };
    }
  },

  async getDeliveryStatus(sessionId: string): Promise<DeliveryStatusBody | null> {
    const res = await fetch(`${API_URL}${ENDPOINTS.deliveryStatus(sessionId)}`);
    if (!res.ok) return null;
    return (await res.json()) as DeliveryStatusBody;
  },
};
