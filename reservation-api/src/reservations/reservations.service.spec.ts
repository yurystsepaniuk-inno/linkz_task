import { Test } from '@nestjs/testing';
import { ConflictException, BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReservationsService } from './reservations.service';
import { PG_POOL } from '../database/database.module';
import { SEAT_STATUS, ERROR_CODE } from '../common/constants';

const makeClient = (statusRow: { status: string } | null) => ({
  query: jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('FOR UPDATE')) {
      return Promise.resolve({ rows: statusRow ? [statusRow] : [] });
    }
    return Promise.resolve({ rows: [] });
  }),
  release: jest.fn(),
});

describe('ReservationsService', () => {
  let service: ReservationsService;
  let mockPool: { connect: jest.Mock; query: jest.Mock };

  const mockConfig = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'PAYMENT_API_URL') return 'http://localhost:3003';
      if (key === 'RESERVATION_AMOUNT') return '10.00';
      throw new Error(`Missing config: ${key}`);
    }),
  };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockPool = { connect: jest.fn(), query: jest.fn().mockResolvedValue({ rows: [] }) };

    const module = await Test.createTestingModule({
      providers: [
        ReservationsService,
        { provide: PG_POOL, useValue: mockPool },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get(ReservationsService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('happy path returns checkoutUrl', async () => {
    const client = makeClient({ status: SEAT_STATUS.AVAILABLE });
    mockPool.connect.mockResolvedValueOnce(client);

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ checkoutUrl: 'http://localhost:3002/checkout/sess_1' }),
    } as Response);

    const result = await service.create({ seatId: 'A1' }, 'user-1');
    expect(result.checkoutUrl).toBe('http://localhost:3002/checkout/sess_1');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it(`throws 409 when seat is ${SEAT_STATUS.PENDING_PAYMENT}`, async () => {
    const client = makeClient({ status: SEAT_STATUS.PENDING_PAYMENT });
    mockPool.connect.mockResolvedValueOnce(client);

    await expect(service.create({ seatId: 'A1' }, 'user-1')).rejects.toThrow(ConflictException);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it(`throws 409 when seat is ${SEAT_STATUS.CONFIRMED}`, async () => {
    const client = makeClient({ status: SEAT_STATUS.CONFIRMED });
    mockPool.connect.mockResolvedValueOnce(client);

    await expect(service.create({ seatId: 'A1' }, 'user-1')).rejects.toThrow(
      new ConflictException(ERROR_CODE.SEAT_ALREADY_OCCUPIED),
    );
  });

  it('compensates and throws 502 when payment api fails', async () => {
    const client = makeClient({ status: SEAT_STATUS.AVAILABLE });
    mockPool.connect.mockResolvedValueOnce(client);

    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('network error'));

    await expect(service.create({ seatId: 'A1' }, 'user-1')).rejects.toThrow(BadGatewayException);
    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE seats'),
      [SEAT_STATUS.AVAILABLE, 'A1'],
    );
  });
});
