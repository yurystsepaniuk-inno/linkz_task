import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { WebhooksService } from './webhooks.service';
import { PG_POOL } from '../database/database.module';
import { PAYMENT_EVENT, SEAT_STATUS, RESERVATION_STATUS } from '../common/constants';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let mockClient: { query: jest.Mock; release: jest.Mock };
  let mockPool: { connect: jest.Mock };
  const secret = 'test-secret';

  const sign = (body: object) =>
    createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

  // Default: reservations UPDATE matches no row. Tests that expect a live
  // reservation override this with `matchReservation`.
  const matchReservation = (seatId: string) => {
    mockClient.query.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('UPDATE reservations')) {
        return Promise.resolve({ rows: [{ seat_id: seatId }] });
      }
      return Promise.resolve({ rows: [] });
    });
  };

  const seatUpdateCalls = () =>
    mockClient.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE seats'),
    );

  beforeEach(async () => {
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    mockPool = { connect: jest.fn().mockResolvedValue(mockClient) };

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
    matchReservation('A1');
    const payload = { event: PAYMENT_EVENT.SUCCEEDED, sessionId: 'cs_abc', seatId: 'A1', userId: 'user-1' };
    const body = Buffer.from(JSON.stringify(payload));
    const sig = sign(payload);

    service.verifySignature(body, sig);
    const result = await service.handle(payload);
    expect(result).toEqual({ received: true });
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE reservations'),
      [RESERVATION_STATUS.CONFIRMED, 'cs_abc', RESERVATION_STATUS.PENDING_PAYMENT],
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE seats'),
      [SEAT_STATUS.CONFIRMED, 'A1', SEAT_STATUS.PENDING_PAYMENT],
    );
  });

  it('releases seat on payment.failed', async () => {
    matchReservation('A2');
    const payload = { event: PAYMENT_EVENT.FAILED, sessionId: 'cs_def', seatId: 'A2', userId: 'user-2' };
    const body = Buffer.from(JSON.stringify(payload));
    const sig = sign(payload);

    service.verifySignature(body, sig);
    const result = await service.handle(payload);
    expect(result).toEqual({ received: true });
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE reservations'),
      [RESERVATION_STATUS.FAILED, 'cs_def', RESERVATION_STATUS.PENDING_PAYMENT],
    );
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE seats'),
      [SEAT_STATUS.AVAILABLE, 'A2', SEAT_STATUS.PENDING_PAYMENT],
    );
  });

  it('updates the seat from the matched reservation, not the webhook payload', async () => {
    // Reservation row says seat A1; payload (potentially forged/stale) claims A3.
    matchReservation('A1');
    const payload = { event: PAYMENT_EVENT.SUCCEEDED, sessionId: 'cs_abc', seatId: 'A3', userId: 'user-1' };
    await service.handle(payload);
    expect(seatUpdateCalls()).toEqual([
      [expect.stringContaining('UPDATE seats'), [SEAT_STATUS.CONFIRMED, 'A1', SEAT_STATUS.PENDING_PAYMENT]],
    ]);
  });

  it('does not touch any seat when no live reservation matches (stale/duplicate webhook)', async () => {
    // Default mock: reservations UPDATE returns zero rows.
    const payload = { event: PAYMENT_EVENT.SUCCEEDED, sessionId: 'cs_stale', seatId: 'A1', userId: 'user-1' };
    const result = await service.handle(payload);
    expect(result).toEqual({ received: true });
    expect(seatUpdateCalls()).toHaveLength(0);
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });
});
