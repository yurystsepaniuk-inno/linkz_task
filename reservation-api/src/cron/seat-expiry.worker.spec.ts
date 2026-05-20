import { Test } from '@nestjs/testing';
import { SeatExpiryWorker } from './seat-expiry.worker';
import { PG_POOL } from '../database/database.module';
import { SEAT_STATUS, RESERVATION_LOCK_TTL_MINUTES } from '../common/constants';

describe('SeatExpiryWorker', () => {
  let worker: SeatExpiryWorker;
  let mockPool: { query: jest.Mock };

  beforeEach(async () => {
    mockPool = { query: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [SeatExpiryWorker, { provide: PG_POOL, useValue: mockPool }],
    }).compile();

    worker = module.get(SeatExpiryWorker);
  });

  it('runs UPDATE with correct seat statuses and TTL parameter', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 2 });
    await worker.expireStaleReservations();
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('UPDATE seats');
    expect(sql).toContain('minutes');
    expect(params).toEqual([
      SEAT_STATUS.AVAILABLE,
      SEAT_STATUS.PENDING_PAYMENT,
      RESERVATION_LOCK_TTL_MINUTES,
    ]);
  });

  it('handles 0 expired rows without error', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 0 });
    await expect(worker.expireStaleReservations()).resolves.not.toThrow();
  });
});
