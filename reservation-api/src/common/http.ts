/**
 * Default timeout for all outbound service-to-service HTTP. Bounded so a hung
 * upstream (TCP black hole, slow receiver, …) can never pin a caller until the
 * OS times out the socket — the calling worker / poller would otherwise stall.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

/**
 * `fetch` with an `AbortSignal.timeout`. The caller still owns retry/backoff;
 * this only guarantees a single attempt cannot block indefinitely.
 */
export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
