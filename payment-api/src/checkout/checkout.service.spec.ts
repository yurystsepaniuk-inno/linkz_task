import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { CheckoutService } from './checkout.service';
import { SessionsRepository } from './sessions.repository';
import { WebhookDeliveryService } from './webhook-delivery.service';
import {
  PAYMENT_EVENT,
  PAYMENT_RESULT,
  SIGNATURE_HEADER,
  SESSION_ID_PREFIX,
  SESSION_STATUS,
} from '../common/constants';
const RESERVATION_AMOUNT = 10;

/**
 * SessionsRepository is mocked here (not provided as the real Postgres-backed
 * implementation) because CheckoutService is the unit under test. Each test
 * configures what `tryClaim` / `getInternal` return — the rest of the
 * service's flow is asserted against those.
 */
describe('CheckoutService', () => {
  let service: CheckoutService;
  let store: {
    create: jest.Mock;
    get: jest.Mock;
    getInternal: jest.Mock;
    tryClaim: jest.Mock;
    update: jest.Mock;
  };
  let delivery: { deliver: jest.Mock; getStatus: jest.Mock };

  const secret = 'test-secret';
  const ENV: Record<string, string> = {
    PUBLIC_BASE_URL: 'http://localhost:3002',
    WEBHOOK_SECRET: secret,
    RESERVATION_API_URL: 'http://localhost:3000',
    // Single source of truth for seat pricing — payment-api owns this number
    // and echoes it back in the createSession response.
    RESERVATION_AMOUNT: RESERVATION_AMOUNT.toFixed(2),
  };

  const okHandle = (deliveryId = 'd-1') => ({ deliveryId, deliveredOnFirstAttempt: true });

  // Helper: build the row object tryClaim would return on a successful claim.
  const claimedRow = (
    overrides: Partial<{ seatId: string; userId: string; amount: number; status: string }> = {},
  ) => ({
    seatId: 'A1',
    userId: 'user-1',
    amount: 10,
    status: SESSION_STATUS.PAID,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });

  beforeEach(async () => {
    store = {
      create: jest.fn(),
      get: jest.fn(),
      getInternal: jest.fn(),
      tryClaim: jest.fn(),
      update: jest.fn(),
    };
    delivery = {
      deliver: jest.fn().mockResolvedValue(okHandle()),
      getStatus: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        CheckoutService,
        { provide: SessionsRepository, useValue: store },
        { provide: WebhookDeliveryService, useValue: delivery },
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

  it('createSession persists a PENDING session and returns a sess_-prefixed checkoutUrl + resolved amount', async () => {
    store.create.mockResolvedValue({ sessionId: `${SESSION_ID_PREFIX}abc` });
    const result = await service.createSession({ seatId: 'A1', userId: 'user-1' });
    // Amount comes from RESERVATION_AMOUNT, not from the caller.
    expect(store.create).toHaveBeenCalledWith('A1', 'user-1', RESERVATION_AMOUNT);
    expect(result.sessionId).toBe(`${SESSION_ID_PREFIX}abc`);
    expect(result.checkoutUrl).toBe(`${ENV.PUBLIC_BASE_URL}/checkout/${SESSION_ID_PREFIX}abc`);
    // The resolved amount is echoed in the response so the caller can write
    // its audit row without keeping its own copy of the env.
    expect(result.amount).toBe(RESERVATION_AMOUNT);
  });

  it('getSession returns the buyer-facing view (seatId + amount only)', async () => {
    store.get.mockResolvedValue(claimedRow({ status: SESSION_STATUS.PENDING }));
    expect(await service.getSession('sess_x')).toEqual({ seatId: 'A1', amount: 10 });
  });

  it('throws 404 for unknown session on get', async () => {
    store.get.mockResolvedValue(undefined);
    await expect(service.getSession(`${SESSION_ID_PREFIX}unknown`)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('pay with 4000 → success: tryClaim → PAID, dispatches a valid HMAC-signed webhook', async () => {
    store.tryClaim.mockResolvedValue(claimedRow({ status: SESSION_STATUS.PAID }));

    const result = await service.pay('sess_1', { cardNumber: '4111-1111-1111-4000' });

    expect(store.tryClaim).toHaveBeenCalledWith('sess_1', SESSION_STATUS.PAID);
    expect(result.status).toBe(PAYMENT_RESULT.SUCCESS);
    expect(result.webhookDelivered).toBe(true);
    expect(result.deliveryId).toBe('d-1');

    const [url, rawBody, signature, sessionId] = delivery.deliver.mock.calls[0];
    expect(url).toBe(`${ENV.RESERVATION_API_URL}/api/webhooks/payment`);
    expect(sessionId).toBe('sess_1');

    const parsed = JSON.parse(rawBody);
    expect(parsed.event).toBe(PAYMENT_EVENT.SUCCEEDED);
    expect(parsed.sessionId).toBe('sess_1');
    expect(parsed.seatId).toBe('A1');
    expect(parsed.userId).toBe('user-1');

    const expectedSig = createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(signature).toBe(expectedSig);
  });

  it('pay with 5000 → failed: tryClaim → FAILED, dispatches payment.failed', async () => {
    store.tryClaim.mockResolvedValue(
      claimedRow({ seatId: 'A2', userId: 'user-2', status: SESSION_STATUS.FAILED }),
    );

    const result = await service.pay('sess_2', { cardNumber: '5000000000005000' });
    expect(store.tryClaim).toHaveBeenCalledWith('sess_2', SESSION_STATUS.FAILED);
    expect(result.status).toBe(PAYMENT_RESULT.FAILED);

    const parsed = JSON.parse(delivery.deliver.mock.calls[0][1] as string);
    expect(parsed.event).toBe(PAYMENT_EVENT.FAILED);
    expect(parsed.userId).toBe('user-2');
  });

  it('propagates webhookDelivered=false when the delivery service is still retrying', async () => {
    store.tryClaim.mockResolvedValue(claimedRow({ status: SESSION_STATUS.PAID }));
    delivery.deliver.mockResolvedValueOnce({
      deliveryId: 'd-pending',
      deliveredOnFirstAttempt: false,
    });

    const result = await service.pay('sess_x', { cardNumber: '4111111111114000' });
    expect(result.webhookDelivered).toBe(false);
    expect(result.deliveryId).toBe('d-pending');
  });

  it('signs the webhook with the configured secret (verifiable end-to-end)', async () => {
    store.tryClaim.mockResolvedValue(claimedRow());
    await service.pay('sess_x', { cardNumber: '4111111111114000' });

    const [, rawBody, signature] = delivery.deliver.mock.calls[0];
    const recomputed = createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(signature).toBe(recomputed);
    expect(typeof SIGNATURE_HEADER).toBe('string');
  });

  it('throws 404 when tryClaim misses and the session is unknown', async () => {
    store.tryClaim.mockResolvedValue(undefined);
    store.getInternal.mockResolvedValue(undefined);

    await expect(
      service.pay(`${SESSION_ID_PREFIX}unknown`, { cardNumber: '4111111111114000' }),
    ).rejects.toThrow(NotFoundException);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('throws 400 when tryClaim misses because the session is already settled', async () => {
    store.tryClaim.mockResolvedValue(undefined);
    // Session exists but is no longer PENDING — already PAID or FAILED.
    store.getInternal.mockResolvedValue(claimedRow({ status: SESSION_STATUS.PAID }));

    await expect(service.pay('sess_settled', { cardNumber: '4111111111114000' })).rejects.toThrow(
      BadRequestException,
    );
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('throws 400 for invalid card before touching the store', async () => {
    await expect(service.pay('sess_1', { cardNumber: '1234123412341234' })).rejects.toThrow(
      BadRequestException,
    );
    expect(store.tryClaim).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
  });
});
