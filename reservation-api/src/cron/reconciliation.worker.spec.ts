import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReconciliationWorker } from './reconciliation.worker';
import { ReconciliationRepository } from './reconciliation.repository';
import { PaymentAuditRepository } from '../audit/payment-audit.repository';
import {
  AUDIT_EVENT,
  AUDIT_OUTCOME,
  API_KEY_HEADER,
  RECONCILIATION_PENDING_MAX_AGE_HOURS,
  REFUND_MAX_ATTEMPTS,
} from '../common/constants';

/**
 * Each test sets up:
 *   - the orphan SELECT result on `pool.query` (one or zero candidate rows)
 *   - a `fetch` mock answering both
 *       GET /api/checkout/sessions/:id/status   (payment-side status lookup)
 *       POST /api/refunds                       (refund issuance)
 *
 * The worker reads response bodies via `res.text()` (text-first, parse-second
 * — see `readJsonOrTrace` in the worker), so the mocks below expose a `text`
 * method returning a JSON-stringified payload rather than the more familiar
 * `json` method. That's intentional: it lets the same harness exercise both
 * the happy JSON path AND the "upstream returned an HTML error page" branch
 * by simply varying the string returned.
 *
 * Assertions focus on:
 *   - which sessions actually result in a refund call
 *   - that exactly one REFUND_INITIATED audit row is written per refunded
 *     session, with the correct outcome
 *   - that PENDING / FAILED sessions are left alone (no refund, no audit)
 *   - that non-JSON upstream responses preserve the raw text in the audit
 *     row instead of being silently flattened to `null`
 *   - that the audit call opts into `dedupeBySession: true` so two replicas
 *     racing on the same orphan collapse to one ledger row
 */
const jsonResp = (
  body: unknown,
  { ok = true, status = ok ? 200 : 400 }: { ok?: boolean; status?: number } = {},
): Response =>
  ({
    ok,
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

/** For the "upstream returned HTML, not JSON" branch. */
const textResp = (
  text: string,
  { ok = false, status = 502 }: { ok?: boolean; status?: number } = {},
): Response =>
  ({
    ok,
    status,
    text: async () => text,
  }) as unknown as Response;

describe('ReconciliationWorker', () => {
  let worker: ReconciliationWorker;
  let repo: { findOrphanedReservations: jest.Mock };
  let audit: {
    record: jest.Mock;
    hasPriorOutcome: jest.Mock;
    countByEvent: jest.Mock;
    findByReservation: jest.Mock;
  };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    repo = { findOrphanedReservations: jest.fn().mockResolvedValue([]) };
    audit = {
      record: jest.fn().mockResolvedValue(undefined),
      hasPriorOutcome: jest.fn().mockResolvedValue(false),
      countByEvent: jest.fn().mockResolvedValue(0),
      findByReservation: jest.fn(),
    };

    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'PAYMENT_API_URL') return 'http://payment-api';
        if (key === 'PAYMENT_API_KEY') return 'test-key';
        throw new Error(`unknown key ${key}`);
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        ReconciliationWorker,
        { provide: ReconciliationRepository, useValue: repo },
        { provide: PaymentAuditRepository, useValue: audit },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    worker = module.get(ReconciliationWorker);
  });

  afterEach(() => jest.restoreAllMocks());

  const ORPHAN_ROW = {
    id: 'res-1',
    seat_id: 'A1',
    user_id: 'user_1',
    session_id: 'cs_orphan',
    // Recent — keeps PENDING-stuck-age dismissal out of the picture for
    // tests that don't exercise it. The single test that does want the
    // age branch overrides this field explicitly.
    created_at: new Date(),
  };
  const stubOrphans = (rows: object[]) => {
    repo.findOrphanedReservations.mockResolvedValueOnce(rows);
  };

  it('skips the candidate query side-effects when no orphans are found', async () => {
    stubOrphans([]);
    const fetchSpy = jest.spyOn(global, 'fetch');

    await worker.reconcileOrphanedPayments();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('delegates orphan discovery to the repository', async () => {
    stubOrphans([]);
    await worker.reconcileOrphanedPayments();
    expect(repo.findOrphanedReservations).toHaveBeenCalledTimes(1);
  });

  it('refunds PAID orphans and writes REFUND_INITIATED with outcome SUCCESS', async () => {
    stubOrphans([ORPHAN_ROW]);
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/checkout/sessions/')) {
        return jsonResp({
          sessionId: 'cs_orphan',
          status: 'PAID',
          seatId: 'A1',
          userId: 'user_1',
          amount: 10,
        });
      }
      if (url.endsWith('/api/refunds')) {
        return jsonResp({ id: 'r-1', session_id: 'cs_orphan', status: 'REFUNDED' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    await worker.reconcileOrphanedPayments();

    // GET status then POST refund — both with the x-api-key header.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const statusCall = fetchSpy.mock.calls[0];
    expect(String(statusCall[0])).toBe(
      'http://payment-api/api/checkout/sessions/cs_orphan/status',
    );
    expect((statusCall[1]!.headers as Record<string, string>)[API_KEY_HEADER]).toBe('test-key');
    const refundCall = fetchSpy.mock.calls[1];
    expect(refundCall[1]!.method).toBe('POST');
    expect((refundCall[1]!.headers as Record<string, string>)[API_KEY_HEADER]).toBe('test-key');
    expect(JSON.parse(refundCall[1]!.body as string)).toMatchObject({ sessionId: 'cs_orphan' });

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry, db, options] = audit.record.mock.calls[0];
    expect(entry).toMatchObject({
      eventType: AUDIT_EVENT.REFUND_INITIATED,
      outcome: AUDIT_OUTCOME.SUCCESS,
      reservationId: 'res-1',
      sessionId: 'cs_orphan',
      seatId: 'A1',
      userId: 'user_1',
      amount: 10,
    });
    // The worker uses the default pool; verify it relies on the dedupe option.
    expect(db).toBeUndefined();
    expect(options).toEqual({ dedupeBySession: true });
  });

  it('records REFUND_ATTEMPT_FAILED (non-terminal) when payment-api rejects the refund, so the next tick retries', async () => {
    stubOrphans([ORPHAN_ROW]);
    audit.countByEvent.mockResolvedValueOnce(0); // no prior failures
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sessions/')) {
        return jsonResp({
          sessionId: 'cs_orphan',
          status: 'PAID',
          seatId: 'A1',
          userId: 'user_1',
          amount: 10,
        });
      }
      return jsonResp(
        { message: 'Cannot refund a FAILED session' },
        { ok: false, status: 400 },
      );
    });

    await worker.reconcileOrphanedPayments();

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry, db, options] = audit.record.mock.calls[0];
    // The transient marker — NOT REFUND_INITIATED. Critical: the orphan
    // SELECT excludes REFUND_INITIATED but not REFUND_ATTEMPT_FAILED, so
    // writing this value here is what lets the next tick retry. Writing
    // REFUND_INITIATED here was the bug.
    expect(entry.eventType).toBe(AUDIT_EVENT.REFUND_ATTEMPT_FAILED);
    expect(entry.outcome).toBe(AUDIT_OUTCOME.FAILED);
    expect(entry.rawPayload).toMatchObject({
      attemptNumber: 1,
      maxAttempts: REFUND_MAX_ATTEMPTS,
    });
    // No dedupe — the retry marker is intentionally non-unique per session.
    expect(db).toBeUndefined();
    expect(options).toBeUndefined();
  });

  it('writes terminal REFUND_GAVE_UP after REFUND_MAX_ATTEMPTS failures so the orphan stops looping', async () => {
    stubOrphans([ORPHAN_ROW]);
    // Prior attempts already at the cap minus one — this attempt pushes us over.
    audit.countByEvent.mockResolvedValueOnce(REFUND_MAX_ATTEMPTS - 1);
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sessions/')) {
        return jsonResp({
          sessionId: 'cs_orphan',
          status: 'PAID',
          seatId: 'A1',
          userId: 'user_1',
          amount: 10,
        });
      }
      return jsonResp({ message: 'still broken' }, { ok: false, status: 500 });
    });

    await worker.reconcileOrphanedPayments();

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry] = audit.record.mock.calls[0];
    expect(entry.eventType).toBe(AUDIT_EVENT.REFUND_GAVE_UP);
    expect(entry.outcome).toBe(AUDIT_OUTCOME.FAILED);
    expect(entry.rawPayload).toMatchObject({
      attemptNumber: REFUND_MAX_ATTEMPTS,
      maxAttempts: REFUND_MAX_ATTEMPTS,
    });
  });

  it('leaves a young PENDING session alone (no refund, no audit) — the webhook may still arrive', async () => {
    stubOrphans([ORPHAN_ROW]); // ORPHAN_ROW.created_at is `new Date()` — within the max age
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      jsonResp({
        sessionId: 'cs_orphan',
        status: 'PENDING',
        seatId: 'A1',
        userId: 'user_1',
        amount: 10,
      }),
    );

    await worker.reconcileOrphanedPayments();

    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the status lookup
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('dismisses a PENDING session that is older than the upper-bound age so it stops re-entering the candidate set', async () => {
    const aging = new Date(
      Date.now() - (RECONCILIATION_PENDING_MAX_AGE_HOURS + 1) * 60 * 60 * 1000,
    );
    stubOrphans([{ ...ORPHAN_ROW, created_at: aging }]);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      jsonResp({
        sessionId: 'cs_orphan',
        status: 'PENDING',
        seatId: 'A1',
        userId: 'user_1',
        amount: 10,
      }),
    );

    await worker.reconcileOrphanedPayments();

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry] = audit.record.mock.calls[0];
    expect(entry).toMatchObject({
      eventType: AUDIT_EVENT.RECONCILIATION_DISMISSED,
      outcome: AUDIT_OUTCOME.NOOP,
      reservationId: 'res-1',
      sessionId: 'cs_orphan',
    });
    expect(entry.rawPayload).toMatchObject({ paymentSessionStatus: 'PENDING' });
  });

  it('dismisses FAILED sessions immediately (no money moved, but record DISMISSED so the orphan SELECT excludes it next tick)', async () => {
    stubOrphans([ORPHAN_ROW]);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      jsonResp({
        sessionId: 'cs_orphan',
        status: 'FAILED',
        seatId: 'A1',
        userId: 'user_1',
        amount: 10,
      }),
    );

    await worker.reconcileOrphanedPayments();

    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the status lookup, no refund POST
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry] = audit.record.mock.calls[0];
    expect(entry).toMatchObject({
      eventType: AUDIT_EVENT.RECONCILIATION_DISMISSED,
      outcome: AUDIT_OUTCOME.NOOP,
      reservationId: 'res-1',
      sessionId: 'cs_orphan',
    });
    expect(entry.rawPayload).toMatchObject({ paymentSessionStatus: 'FAILED' });
  });

  it('skips a reservation gracefully when payment-api is unreachable', async () => {
    stubOrphans([ORPHAN_ROW]);
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(worker.reconcileOrphanedPayments()).resolves.toBeUndefined();
    expect(audit.record).not.toHaveBeenCalled(); // try again next tick
  });

  it('keeps going when one reservation throws — the rest still get reconciled', async () => {
    stubOrphans([ORPHAN_ROW, { ...ORPHAN_ROW, id: 'res-2', session_id: 'cs_2' }]);
    let calls = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      calls += 1;
      // First reservation's status lookup throws; second succeeds with PAID
      // then its refund succeeds.
      if (calls === 1) throw new Error('boom');
      if (calls === 2) {
        return jsonResp({
          sessionId: 'cs_2',
          status: 'PAID',
          seatId: 'A1',
          userId: 'user_1',
          amount: 10,
        });
      }
      return jsonResp({ id: 'r-2' });
    });

    await worker.reconcileOrphanedPayments();

    // One audit row for res-2, none for res-1 (skipped on lookup error).
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record.mock.calls[0][0].reservationId).toBe('res-2');
  });

  // -----------------------------------------------------------------------
  // Diagnostic preservation: the previous `await res.json().catch(() => null)`
  // turned every non-JSON upstream response into `null`, destroying the only
  // piece of evidence we have when reconciliation refunds start failing.
  // These tests pin down the new behavior: parse failures keep the raw text.
  // -----------------------------------------------------------------------

  it('preserves the raw text in the audit row when payment-api refund response is non-JSON (e.g. a 502 HTML error page)', async () => {
    stubOrphans([ORPHAN_ROW]);
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sessions/')) {
        return jsonResp({
          sessionId: 'cs_orphan',
          status: 'PAID',
          seatId: 'A1',
          userId: 'user_1',
          amount: 10,
        });
      }
      // Refund call gets back a proxy HTML error page, NOT JSON.
      return textResp('<html><body>502 Bad Gateway</body></html>', {
        ok: false,
        status: 502,
      });
    });

    await worker.reconcileOrphanedPayments();

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry] = audit.record.mock.calls[0];
    expect(entry.outcome).toBe(AUDIT_OUTCOME.FAILED);
    // Crucially: rawPayload.refundResponse must carry the unparsable text,
    // not null. This is the only diagnostic an operator gets at 3am.
    const refundResponse = entry.rawPayload.refundResponse;
    expect(refundResponse).toMatchObject({
      httpStatus: 502,
      rawText: expect.stringContaining('502 Bad Gateway'),
    });
    expect(refundResponse.parseError).toEqual(expect.any(String));
  });

  it('skips reconciliation (no refund, no audit) when the status lookup returns non-JSON we cannot trust', async () => {
    stubOrphans([ORPHAN_ROW]);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      textResp('<html>Service Unavailable</html>', { ok: true, status: 200 }),
    );

    await worker.reconcileOrphanedPayments();

    // No refund attempt — we can't tell if the session was PAID, so we
    // must not act. Next cron tick can try again with a parseable response.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips reconciliation when the status response is JSON but missing required fields', async () => {
    // The structural guard `isSessionStatusResponse` rejects ambiguous bodies
    // so we don't accidentally branch on a `parseError`-trace object as if
    // it had a real `.status` field.
    stubOrphans([ORPHAN_ROW]);
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      jsonResp({ parseError: 'something', rawText: 'oops' }),
    );

    await worker.reconcileOrphanedPayments();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('handles a zero-length refund body without crashing — body is recorded as null', async () => {
    stubOrphans([ORPHAN_ROW]);
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/sessions/')) {
        return jsonResp({
          sessionId: 'cs_orphan',
          status: 'PAID',
          seatId: 'A1',
          userId: 'user_1',
          amount: 10,
        });
      }
      return textResp('', { ok: true, status: 204 });
    });

    await worker.reconcileOrphanedPayments();

    expect(audit.record).toHaveBeenCalledTimes(1);
    const [entry] = audit.record.mock.calls[0];
    // ok=true and an empty body is treated as "no payload" — not a parse
    // error. The audit row carries refundResponse=null for that case.
    expect(entry.outcome).toBe(AUDIT_OUTCOME.SUCCESS);
    expect(entry.rawPayload.refundResponse).toBeNull();
  });
});
