import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { WebhooksService } from './webhooks.service';
import { PG_POOL } from '../database/database.module';
import { PAYMENT_EVENT, SEAT_STATUS, RESERVATION_STATUS } from '../common/constants';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let mockPool: { query: jest.Mock };
  const secret = 'test-secret';

  const sign = (body: object) =>
    createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

  beforeEach(async () => {
    mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    const module = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: PG_POOL, useValue: mockPool },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue(secret) } },
      ],
    }).compile();

    service = module.get(WebhooksService);
  });

  it('throws 401 on invalid signature', () => {
    const body = Buffer.from(JSON.stringify({ event: PAYMENT_EVENT.SUCCEEDED, sessionId: 'cs_abc', seatId: 'A1', userId: 'user-1' }));
    expect(() => service.verifySignature(body, 'badsig')).toThrow(UnauthorizedException);
  });

  it('accepts valid signature and confirms seat on payment.succeeded', async () => {
    const payload = { event: PAYMENT_EVENT.SUCCEEDED, sessionId: 'cs_abc', seatId: 'A1', userId: 'user-1' };
    const body = Buffer.from(JSON.stringify(payload));
    const sig = sign(payload);

    service.verifySignature(body, sig);
    const result = await service.handle(payload);
    expect(result).toEqual({ received: true });
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE reservations'),
      [RESERVATION_STATUS.CONFIRMED, 'cs_abc', RESERVATION_STATUS.PENDING_PAYMENT],
    );
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE seats'),
      [SEAT_STATUS.CONFIRMED, 'A1', SEAT_STATUS.PENDING_PAYMENT],
    );
  });

  it('releases seat on payment.failed', async () => {
    const payload = { event: PAYMENT_EVENT.FAILED, sessionId: 'cs_def', seatId: 'A2', userId: 'user-2' };
    const body = Buffer.from(JSON.stringify(payload));
    const sig = sign(payload);

    service.verifySignature(body, sig);
    const result = await service.handle(payload);
    expect(result).toEqual({ received: true });
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE reservations'),
      [RESERVATION_STATUS.FAILED, 'cs_def', RESERVATION_STATUS.PENDING_PAYMENT],
    );
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE seats'),
      [SEAT_STATUS.AVAILABLE, 'A2', SEAT_STATUS.PENDING_PAYMENT],
    );
  });

  it('is idempotent for non-PENDING seat (no-op update)', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 });
    const payload = { event: PAYMENT_EVENT.SUCCEEDED, sessionId: 'cs_abc', seatId: 'A1', userId: 'user-1' };
    const result = await service.handle(payload);
    expect(result).toEqual({ received: true });
  });
});
