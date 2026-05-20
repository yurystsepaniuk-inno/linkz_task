import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { CheckoutService } from './checkout.service';
import { SessionsStore } from './sessions.store';
import {
  PAYMENT_EVENT,
  PAYMENT_RESULT,
  SIGNATURE_HEADER,
  SESSION_ID_PREFIX,
} from '../common/constants';

describe('CheckoutService', () => {
  let service: CheckoutService;

  const secret = 'test-secret';
  const ENV: Record<string, string> = {
    PUBLIC_BASE_URL: 'http://localhost:3002',
    WEBHOOK_SECRET: secret,
    RESERVATION_API_URL: 'http://localhost:3000',
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        CheckoutService,
        SessionsStore,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              if (ENV[key] === undefined) throw new Error(`Missing: ${key}`);
              return ENV[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get(CheckoutService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates a session and returns sessionId + checkoutUrl', () => {
    const result = service.createSession({ seatId: 'A1', userId: 'user-1', amount: 10 });
    expect(result.sessionId.startsWith(SESSION_ID_PREFIX)).toBe(true);
    expect(result.checkoutUrl).toContain(`/checkout/${SESSION_ID_PREFIX}`);
  });

  it('retrieves an existing session', () => {
    const { sessionId } = service.createSession({ seatId: 'A1', userId: 'user-1', amount: 10 });
    const session = service.getSession(sessionId);
    expect(session).toEqual({ seatId: 'A1', amount: 10 });
  });

  it('throws 404 for unknown session on get', () => {
    expect(() => service.getSession(`${SESSION_ID_PREFIX}unknown`)).toThrow(NotFoundException);
  });

  it('pay with 4000 → success + webhook called with payment.succeeded + valid signature', async () => {
    const { sessionId } = service.createSession({ seatId: 'A1', userId: 'user-1', amount: 10 });

    let capturedSig = '';
    let capturedBody = '';
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedSig = (init?.headers as Record<string, string>)[SIGNATURE_HEADER];
      capturedBody = init?.body as string;
      return { ok: true } as Response;
    });

    const result = await service.pay(sessionId, { cardNumber: '4111-1111-1111-4000' });
    expect(result.status).toBe(PAYMENT_RESULT.SUCCESS);

    const expected = createHmac('sha256', secret).update(capturedBody).digest('hex');
    expect(capturedSig).toBe(expected);

    const parsed = JSON.parse(capturedBody);
    expect(parsed.event).toBe(PAYMENT_EVENT.SUCCEEDED);
    expect(parsed.seatId).toBe('A1');
    expect(parsed.userId).toBe('user-1');
  });

  it('pay with 5000 → failed + webhook called with payment.failed', async () => {
    const { sessionId } = service.createSession({ seatId: 'A2', userId: 'user-2', amount: 10 });

    let capturedBody = '';
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = init?.body as string;
      return { ok: true } as Response;
    });

    const result = await service.pay(sessionId, { cardNumber: '5000000000005000' });
    expect(result.status).toBe(PAYMENT_RESULT.FAILED);

    const parsed = JSON.parse(capturedBody);
    expect(parsed.event).toBe(PAYMENT_EVENT.FAILED);
    expect(parsed.userId).toBe('user-2');
  });

  it('throws 404 for unknown session on pay', async () => {
    await expect(
      service.pay(`${SESSION_ID_PREFIX}unknown`, { cardNumber: '4111111111114000' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws 400 for invalid card', async () => {
    const { sessionId } = service.createSession({ seatId: 'A1', userId: 'user-1', amount: 10 });
    await expect(service.pay(sessionId, { cardNumber: '1234123412341234' })).rejects.toThrow(
      BadRequestException,
    );
  });
});
