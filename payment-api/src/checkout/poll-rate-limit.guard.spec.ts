import { ExecutionContext, HttpException } from '@nestjs/common';
import { PollRateLimitGuard } from './poll-rate-limit.guard';

function ctxFor(ip: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ ip, socket: { remoteAddress: ip } }),
    }),
  } as unknown as ExecutionContext;
}

describe('PollRateLimitGuard', () => {
  it('allows requests under the per-IP cap', () => {
    const guard = new PollRateLimitGuard();
    const ctx = ctxFor('10.0.0.1');
    for (let i = 0; i < 50; i++) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('throws 429 once the cap is exceeded for a given IP', () => {
    const guard = new PollRateLimitGuard();
    const ctx = ctxFor('10.0.0.2');
    // 120 = MAX_REQUESTS; the 121st must trip the limit.
    for (let i = 0; i < 120; i++) guard.canActivate(ctx);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
  });

  it('caps per-IP, not globally — a different IP is unaffected', () => {
    const guard = new PollRateLimitGuard();
    const noisyCtx = ctxFor('10.0.0.3');
    for (let i = 0; i < 120; i++) guard.canActivate(noisyCtx);
    expect(() => guard.canActivate(noisyCtx)).toThrow(HttpException);

    const quietCtx = ctxFor('10.0.0.4');
    expect(guard.canActivate(quietCtx)).toBe(true);
  });

  it('forgets hits outside the sliding window', () => {
    jest.useFakeTimers();
    try {
      const guard = new PollRateLimitGuard();
      const ctx = ctxFor('10.0.0.5');
      for (let i = 0; i < 120; i++) guard.canActivate(ctx);

      // Wind past the 60-second window — old hits should age out.
      jest.advanceTimersByTime(60_001);
      expect(guard.canActivate(ctx)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
