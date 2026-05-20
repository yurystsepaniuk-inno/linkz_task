import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PG_POOL } from '../database/database.module';
import * as bcrypt from 'bcrypt';

describe('AuthService', () => {
  let service: AuthService;
  let mockPool: { query: jest.Mock };

  beforeEach(async () => {
    mockPool = { query: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PG_POOL, useValue: mockPool },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('signed-token') },
        },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('returns token on valid credentials', async () => {
    const hash = await bcrypt.hash('password123', 10);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'user-1', password_hash: hash }] });

    const result = await service.login({ email: 'alice@example.com', password: 'password123' });
    expect(result.token).toBe('signed-token');
  });

  it('throws on wrong password', async () => {
    const hash = await bcrypt.hash('other', 10);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'user-1', password_hash: hash }] });

    await expect(service.login({ email: 'alice@example.com', password: 'wrong' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws on unknown email', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      service.login({ email: 'nobody@example.com', password: 'password123' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
