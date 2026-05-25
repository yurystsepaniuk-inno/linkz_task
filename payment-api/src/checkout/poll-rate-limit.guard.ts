import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

// Minimal shape we need from the incoming HTTP request. Avoids depending on
// `@types/express` (not in devDependencies) for what is essentially two
// properties.
type ClientRequest = { ip?: string; socket?: { remoteAddress?: string } };

/**
 * In-process per-IP sliding-window rate limiter for the buyer-facing
 * `/delivery-status` poll. The endpoint has no auth (session_id is the secret),
 * so without a cap a hostile client could turn it into a free heartbeat.
 *
 * Bucket size and window are sized generously for legitimate polling:
 * ResultPage backs off to ~10s tail cadence and gives up after 5 minutes, so a
 * single tab will never exceed ~40 requests in 60 seconds. The 120/min cap
 * leaves headroom for a few simultaneous tabs while still stopping abuse.
 *
 * In-memory state is appropriate for the current single-instance topology; if
 * payment-api ever scales horizontally, replace this with a shared store
 * (Redis INCR + EXPIRE) so the limit holds across replicas.
 */
@Injectable()
export class PollRateLimitGuard implements CanActivate {
  private static readonly WINDOW_MS = 60_000;
  private static readonly MAX_REQUESTS = 120;
  private static readonly SWEEP_THRESHOLD = 1024;

  private readonly hits = new Map<string, number[]>();

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<ClientRequest>();
    const key = this.clientKey(req);
    const now = Date.now();
    const cutoff = now - PollRateLimitGuard.WINDOW_MS;

    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (timestamps.length >= PollRateLimitGuard.MAX_REQUESTS) {
      throw new HttpException(
        { message: 'Too many polls; back off and retry.', code: 'RATE_LIMITED' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);

    // Opportunistic GC so a long-running process doesn't accumulate stale IPs
    // forever. Only sweeps when the map grows past the threshold, keeping the
    // hot path O(1) for the steady state.
    if (this.hits.size > PollRateLimitGuard.SWEEP_THRESHOLD) {
      this.gc(cutoff);
    }
    return true;
  }

  private gc(cutoff: number): void {
    for (const [k, v] of this.hits) {
      const fresh = v.filter((t) => t > cutoff);
      if (fresh.length === 0) this.hits.delete(k);
      else this.hits.set(k, fresh);
    }
  }

  private clientKey(req: ClientRequest): string {
    // Express populates `ip` from X-Forwarded-For when `trust proxy` is on,
    // otherwise from the socket. Fall back to a single global bucket if the
    // request somehow lacks both — that still rate-limits, just less fairly.
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}
