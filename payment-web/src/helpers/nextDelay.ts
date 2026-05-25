import { POLL_BACKOFF_FACTOR, POLL_MAX_MS } from '../consts';

export function nextDelay(prev: number): number {
  return Math.min(Math.round(prev * POLL_BACKOFF_FACTOR), POLL_MAX_MS);
}
