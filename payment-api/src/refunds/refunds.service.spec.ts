import { Test } from '@nestjs/testing';
import { Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { RefundsService, RefundRow } from './refunds.service';
import { RefundsRepository } from './refunds.repository';
import { SessionsRepository } from '../checkout/sessions.repository';
import { SESSION_STATUS, REFUND_STATUS } from '../common/constants';

/**
 * Tests cover the four interesting paths through `create()`:
 *   1. happy path: session is PAID, refund row INSERTed and returned
 *   2. idempotency: calling twice with the same session returns the existing row
 *      and skips the INSERT (proves the "no double refund" guarantee at the
 *      service layer; the UNIQUE constraint is the second line of defense)
 *   3. session not found → 404 (caller's mistake, not a silent no-op)
 *   4. session not PAID → 400 (refusing to refund a charge that didn't happen)
 */
describe('RefundsService', () => {
  let service: RefundsService;
  let refunds: { findBySession: jest.Mock; upsert: jest.Mock };
  let sessions: { getInternal: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    refunds = { findBySession: jest.fn(), upsert: jest.fn() };
    sessions = { getInternal: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        RefundsService,
        { provide: RefundsRepository, useValue: refunds },
        { provide: SessionsRepository, useValue: sessions },
      ],
    }).compile();
    service = module.get(RefundsService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('refunds a PAID session, inserts one row, logs it', async () => {
    refunds.findBySession.mockResolvedValue(undefined);
    sessions.getInternal.mockResolvedValue({
      seatId: 'A1',
      userId: 'user_1',
      amount: 10,
      status: SESSION_STATUS.PAID,
      expiresAt: Date.now() + 60_000,
    });
    const inserted: RefundRow = {
      id: 'r-1',
      session_id: 'cs_1',
      amount: '10.00',
      reason: 'reconciliation',
      status: REFUND_STATUS.REFUNDED,
      created_at: new Date(),
    };
    refunds.upsert.mockResolvedValue(inserted);

    const result = await service.create({ sessionId: 'cs_1', reason: 'reconciliation' });

    expect(result).toEqual(inserted);
    expect(refunds.upsert).toHaveBeenCalledWith(
      'cs_1',
      10,
      'reconciliation',
      REFUND_STATUS.REFUNDED,
    );
  });

  it('is idempotent: a second call for the same session returns the existing row without INSERTing', async () => {
    const existing: RefundRow = {
      id: 'r-1',
      session_id: 'cs_1',
      amount: '10.00',
      reason: null,
      status: REFUND_STATUS.REFUNDED,
      created_at: new Date(),
    };
    refunds.findBySession.mockResolvedValue(existing);

    const result = await service.create({ sessionId: 'cs_1' });

    expect(result).toEqual(existing);
    expect(refunds.upsert).not.toHaveBeenCalled();
    expect(sessions.getInternal).not.toHaveBeenCalled();
  });

  it('throws 404 when the session is unknown', async () => {
    refunds.findBySession.mockResolvedValue(undefined);
    sessions.getInternal.mockResolvedValue(undefined);

    await expect(service.create({ sessionId: 'cs_missing' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(refunds.upsert).not.toHaveBeenCalled();
  });

  it('throws 400 when the session is not in PAID status', async () => {
    refunds.findBySession.mockResolvedValue(undefined);
    sessions.getInternal.mockResolvedValue({
      seatId: 'A1',
      userId: 'user_1',
      amount: 10,
      status: SESSION_STATUS.PENDING,
      expiresAt: Date.now() + 60_000,
    });

    await expect(service.create({ sessionId: 'cs_pending' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(refunds.upsert).not.toHaveBeenCalled();
  });

  it('findBySession returns undefined when no row exists', async () => {
    refunds.findBySession.mockResolvedValue(undefined);
    await expect(service.findBySession('cs_none')).resolves.toBeUndefined();
  });
});
