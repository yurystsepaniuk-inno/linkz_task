/** Polling cadence — exponential backoff so a fast-settling delivery feels
 *  snappy while a stuck one doesn't hammer the unauthenticated endpoint.
 *  Sequence: 1500, 2250, 3375, 5062, 7593, 10000, 10000…ms (clamped).
 *  Over the 5-minute timeout that's ~33 requests, comfortably under the
 *  120/min per-IP server cap even with several browser tabs open. */
export const POLL_BASE_MS = 1500;
export const POLL_MAX_MS = 10_000;
export const POLL_BACKOFF_FACTOR = 1.5;
export const POLL_TIMEOUT_MS = 5 * 60 * 1000;
