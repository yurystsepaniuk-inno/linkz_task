import { Test } from '@nestjs/testing';
import { SeatExpiryWorker } from './seat-expiry.worker';
import { SeatExpiryRepository } from './seat-expiry.repository';
import { PaymentAuditRepository } from '../audit/payment-audit.repository';
import { TransactionRunner } from '../database/transaction.runner';
import { AUDIT_EVENT } from '../common/constants';

describe('SeatExpiryWorker', () => {
  let worker: SeatExpiryWorker;
  let repo: { expireStaleReservations: jest.Mock; releaseSeats: jest.Mock };
  let mockAudit: { record: jest.Mock; hasPriorOutcome: jest.Mock; findByReservation: jest.Mock };
  let tx: { run: jest.Mock };
  let clientQuery: jest.Mock;
  let fakeClient: { query: jest.Mock };

  beforeEach(async () => {
    // The worker now calls `pg_try_advisory_xact_lock` on the client before
    // doing any real work — make the mock client honor it. Default = lock
    // acquired so the existing assertions about expire/release fire.
    clientQuery = jest.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ locked: true }] };
      }
      return { rows: [] };
    });
    fakeClient = { query: clientQuery };
    repo = {
      expireStaleReservations: jest.fn().mockResolvedValue([]),
      releaseSeats: jest.fn().mockResolvedValue(undefined),
    };
    mockAudit = {
      record: jest.fn().mockResolvedValue(undefined),
      hasPriorOutcome: jest.fn().mockResolvedValue(false),
      findByReservation: jest.fn(),
    };
    tx = {
      run: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(fakeClient)),
    };

    const module = await Test.createTestingModule({
      providers: [
        SeatExpiryWorker,
        { provide: SeatExpiryRepository, useValue: repo },
        { provide: PaymentAuditRepository, useValue: mockAudit },
        { provide: TransactionRunner, useValue: tx },
      ],
    }).compile();

    worker = module.get(SeatExpiryWorker);
  });

  it('expires reservations, releases seats, and audits one RESERVATION_EXPIRED row each', async () => {
    repo.expireStaleReservations.mockResolvedValue([
      { id: 'res-1', seat_id: 'A1', user_id: 'user-1', session_id: 'cs_1' },
      { id: 'res-2', seat_id: 'A2', user_id: 'user-2', session_id: null },
    ]);

    await worker.expireStaleReservations();

    expect(repo.expireStaleReservations).toHaveBeenCalledWith(fakeClient);
    expect(repo.releaseSeats).toHaveBeenCalledWith(['A1', 'A2'], fakeClient);

    expect(mockAudit.record).toHaveBeenCalledTimes(2);
    for (const [entry, db] of mockAudit.record.mock.calls) {
      expect(entry.eventType).toBe(AUDIT_EVENT.RESERVATION_EXPIRED);
      expect(db).toBe(fakeClient);
    }
  });

  it('handles 0 expired rows without touching seats or the audit ledger', async () => {
    repo.expireStaleReservations.mockResolvedValue([]);

    await expect(worker.expireStaleReservations()).resolves.not.toThrow();
    expect(repo.releaseSeats).not.toHaveBeenCalled();
    expect(mockAudit.record).not.toHaveBeenCalled();
  });

  it('short-circuits when another replica holds the advisory lock', async () => {
    clientQuery.mockImplementationOnce(async () => ({ rows: [{ locked: false }] }));

    await worker.expireStaleReservations();

    expect(repo.expireStaleReservations).not.toHaveBeenCalled();
    expect(repo.releaseSeats).not.toHaveBeenCalled();
    expect(mockAudit.record).not.toHaveBeenCalled();
  });
});
