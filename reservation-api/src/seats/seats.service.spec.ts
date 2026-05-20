import { Test } from '@nestjs/testing';
import { SeatsService } from './seats.service';
import { PG_POOL } from '../database/database.module';

describe('SeatsService', () => {
  let service: SeatsService;
  let mockPool: { query: jest.Mock };

  beforeEach(async () => {
    mockPool = { query: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [SeatsService, { provide: PG_POOL, useValue: mockPool }],
    }).compile();

    service = module.get(SeatsService);
  });

  it('returns 3 seats with id and status', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 'A1', status: 'AVAILABLE' },
        { id: 'A2', status: 'PENDING_PAYMENT' },
        { id: 'A3', status: 'CONFIRMED' },
      ],
    });

    const seats = await service.findAll();
    expect(seats).toHaveLength(3);
    expect(seats[0]).toEqual({ id: 'A1', status: 'AVAILABLE' });
    expect(seats[1]).toEqual({ id: 'A2', status: 'PENDING_PAYMENT' });
    expect(seats[2]).toEqual({ id: 'A3', status: 'CONFIRMED' });
  });
});
