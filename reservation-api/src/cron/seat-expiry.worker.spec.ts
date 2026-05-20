import { Test } from '@nestjs/testing';
import { SeatExpiryWorker } from './seat-expiry.worker';
import { PG_POOL } from '../database/database.module';
import { SEAT_STATUS, RESERVATION_STATUS, RESERVATION_LOCK_TTL_MINUTES } from '../common/constants';

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

  it('expires reservations and releases seats with correct parameters', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rowCount: 2, rows: [{ seat_id: 'A1' }, { seat_id: 'A2' }] })
      .mockResolvedValueOnce({ rowCount: 2 });

    await worker.expireStaleReservations();

    const [reservationSql, reservationParams] = mockPool.query.mock.calls[0];
    expect(reservationSql).toContain('UPDATE reservations');
    expect(reservationSql).toContain('minutes');
    expect(reservationParams).toEqual([
      RESERVATION_STATUS.EXPIRED,
      RESERVATION_STATUS.PENDING_PAYMENT,
      RESERVATION_LOCK_TTL_MINUTES,
    ]);

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE seats'),
      [SEAT_STATUS.AVAILABLE, ['A1', 'A2']],
    );
  });

  it('handles 0 expired rows without error and skips seat update', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(worker.expireStaleReservations()).resolves.not.toThrow();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});
