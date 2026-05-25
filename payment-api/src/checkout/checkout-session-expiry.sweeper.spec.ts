import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { CheckoutSessionExpirySweeper } from './checkout-session-expiry.sweeper';
import { CheckoutSessionExpiryRepository } from './checkout-session-expiry.repository';

describe('CheckoutSessionExpirySweeper', () => {
  let sweeper: CheckoutSessionExpirySweeper;
  let repo: { expireStale: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    repo = { expireStale: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        CheckoutSessionExpirySweeper,
        { provide: CheckoutSessionExpiryRepository, useValue: repo },
      ],
    }).compile();
    sweeper = module.get(CheckoutSessionExpirySweeper);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the count the repository reports and bumps the metric when > 0', async () => {
    repo.expireStale.mockResolvedValue(3);
    await expect(sweeper.expireStaleSessions()).resolves.toBe(3);
    expect(repo.expireStale).toHaveBeenCalledTimes(1);
  });

  it('returns 0 when there is nothing to sweep', async () => {
    repo.expireStale.mockResolvedValue(0);
    await expect(sweeper.expireStaleSessions()).resolves.toBe(0);
  });

  it('propagates repository errors to the caller', async () => {
    repo.expireStale.mockRejectedValue(new Error('db down'));
    await expect(sweeper.expireStaleSessions()).rejects.toThrow('db down');
  });
});
