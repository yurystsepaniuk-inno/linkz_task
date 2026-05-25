import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';
import { API_KEY_HEADER } from '../common/constants';

const makeContext = (headers: Record<string, string>): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  }) as unknown as ExecutionContext;

describe('ApiKeyGuard', () => {
  const apiKey = 'test-api-key';
  let guard: ApiKeyGuard;

  beforeEach(() => {
    const config = { getOrThrow: jest.fn().mockReturnValue(apiKey) } as unknown as ConfigService;
    guard = new ApiKeyGuard(config);
  });

  it('allows request with correct API key', () => {
    const ctx = makeContext({ [API_KEY_HEADER]: apiKey });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws 401 when API key header is missing', () => {
    const ctx = makeContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws 401 when API key is wrong', () => {
    const ctx = makeContext({ [API_KEY_HEADER]: 'wrong-key' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
