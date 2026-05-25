import { Test } from '@nestjs/testing';
import { PaymentAuditRepository } from './payment-audit.repository';
import { PG_POOL } from '../database/database.module';
import { AUDIT_EVENT, AUDIT_OUTCOME } from '../common/constants';

describe('PaymentAuditRepository', () => {
  let repo: PaymentAuditRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(async () => {
    mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    const module = await Test.createTestingModule({
      providers: [PaymentAuditRepository, { provide: PG_POOL, useValue: mockPool }],
    }).compile();

    repo = module.get(PaymentAuditRepository);
  });

  it('record() writes one row with the supplied fields', async () => {
    await repo.record({
      eventType: AUDIT_EVENT.WEBHOOK_RECEIVED,
      outcome: AUDIT_OUTCOME.SUCCESS,
      sessionId: 'cs_1',
      seatId: 'A1',
      userId: 'user_1',
      signatureValid: true,
      rawPayload: { foo: 'bar' },
    });
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO payment_transactions');
    expect(sql).not.toContain('ON CONFLICT');
    expect(params[5]).toBe(AUDIT_EVENT.WEBHOOK_RECEIVED);
    expect(params[6]).toBe(AUDIT_OUTCOME.SUCCESS);
    // rawPayload is serialized to JSON.
    expect(params[8]).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('record() with dedupeBySession adds the partial-index conflict target', async () => {
    await repo.record(
      {
        eventType: AUDIT_EVENT.REFUND_INITIATED,
        outcome: AUDIT_OUTCOME.SUCCESS,
        sessionId: 'cs_1',
      },
      undefined,
      { dedupeBySession: true },
    );
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (session_id) WHERE event_type =');
    expect(sql).toContain('DO NOTHING');
  });

  it('hasPriorOutcome() returns the boolean directly from the EXISTS query', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ exists: true }] });
    await expect(repo.hasPriorOutcome('cs_1', AUDIT_EVENT.PAYMENT_SUCCEEDED)).resolves.toBe(true);
    mockPool.query.mockResolvedValueOnce({ rows: [{ exists: false }] });
    await expect(repo.hasPriorOutcome('cs_1', AUDIT_EVENT.PAYMENT_SUCCEEDED)).resolves.toBe(false);
  });

  it('findByReservation() orders rows by created_at ASC', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'a' }] });
    await repo.findByReservation('res-1');
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('ORDER BY created_at ASC');
    expect(params).toEqual(['res-1']);
  });
});
