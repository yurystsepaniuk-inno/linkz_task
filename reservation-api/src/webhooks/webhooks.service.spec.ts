import { Test } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { WebhooksService } from './webhooks.service';
import { WebhooksRepository } from './webhooks.repository';
import { PaymentAuditRepository } from '../audit/payment-audit.repository';
import { TransactionRunner } from '../database/transaction.runner';
import {
  PAYMENT_EVENT,
  SEAT_STATUS,
  RESERVATION_STATUS,
  AUDIT_EVENT,
  AUDIT_OUTCOME,
} from '../common/constants';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let repo: {
    transitionReservation: jest.Mock;
    setSeatStatusIfPending: jest.Mock;
  };
  let mockAudit: {
    record: jest.Mock;
    hasPriorOutcome: jest.Mock;
    findByReservation: jest.Mock;
  };
  let tx: { run: jest.Mock };
  const fakeClient = {} as never;
  const secret = 'test-secret';

  const sign = (body: object) =>
    createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

  const matchReservation = (id: string, seatId: string) => {
    repo.transitionReservation.mockResolvedValue({ id, seat_id: seatId });
  };

  const auditEntries = (eventType: string) =>
    mockAudit.record.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.eventType === eventType);

  beforeEach(async () => {
    repo = {
      transitionReservation: jest.fn().mockResolvedValue(undefined),
      setSeatStatusIfPending: jest.fn().mockResolvedValue(undefined),
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
        WebhooksService,
        { provide: WebhooksRepository, useValue: repo },
        { provide: PaymentAuditRepository, useValue: mockAudit },
        { provide: TransactionRunner, useValue: tx },
        { provide: ConfigService, useValue: { getOrThrow: jest.fn().mockReturnValue(secret) } },
      ],
    }).compile();

    service = module.get(WebhooksService);
  });

  const body = (p: object) => Buffer.from(JSON.stringify(p));

  it('rejects an invalid signature with 401 and audits SIGNATURE_REJECTED', async () => {
    const payload = {
      event: PAYMENT_EVENT.SUCCEEDED,
      sessionId: 'cs_abc',
      seatId: 'A1',
      userId: 'user-1',
    };
    await expect(service.handle(payload, body(payload), 'badsig')).rejects.toThrow(
      UnauthorizedException,
    );
    const rejected = auditEntries(AUDIT_EVENT.SIGNATURE_REJECTED);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ outcome: AUDIT_OUTCOME.REJECTED, signatureValid: false });
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('rejects a missing raw body with 401 and audits SIGNATURE_REJECTED', async () => {
    const payload = {
      event: PAYMENT_EVENT.SUCCEEDED,
      sessionId: 'cs_abc',
      seatId: 'A1',
      userId: 'user-1',
    };
    await expect(service.handle(payload, undefined, '')).rejects.toThrow(UnauthorizedException);
    expect(auditEntries(AUDIT_EVENT.SIGNATURE_REJECTED)).toHaveLength(1);
  });

  it('rejects an unknown event with 400', async () => {
    const payload = {
      event: 'payment.exploded',
      sessionId: 'cs_abc',
      seatId: 'A1',
      userId: 'user-1',
    };
    await expect(service.handle(payload as never, body(payload), sign(payload))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('confirms the seat and audits WEBHOOK_RECEIVED + PAYMENT_SUCCEEDED on payment.succeeded', async () => {
    matchReservation('res-1', 'A1');
    const payload = {
      event: PAYMENT_EVENT.SUCCEEDED,
      sessionId: 'cs_abc',
      seatId: 'A1',
      userId: 'user-1',
    };

    const result = await service.handle(payload, body(payload), sign(payload));
    expect(result).toEqual({ received: true });

    expect(repo.transitionReservation).toHaveBeenCalledWith(
      'cs_abc',
      RESERVATION_STATUS.CONFIRMED,
      fakeClient,
    );
    expect(repo.setSeatStatusIfPending).toHaveBeenCalledWith(
      'A1',
      SEAT_STATUS.CONFIRMED,
      fakeClient,
    );

    expect(auditEntries(AUDIT_EVENT.WEBHOOK_RECEIVED)).toHaveLength(1);
    const succeeded = auditEntries(AUDIT_EVENT.PAYMENT_SUCCEEDED);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).toMatchObject({ outcome: AUDIT_OUTCOME.SUCCESS, reservationId: 'res-1' });
    for (const [, db] of mockAudit.record.mock.calls) {
      // Signature-rejection writes use the pool default (undefined db); all the
      // transactional ones go through the fake client.
      if (db !== undefined) expect(db).toBe(fakeClient);
    }
  });

  it('releases the seat and audits PAYMENT_FAILED on payment.failed', async () => {
    matchReservation('res-2', 'A2');
    const payload = {
      event: PAYMENT_EVENT.FAILED,
      sessionId: 'cs_def',
      seatId: 'A2',
      userId: 'user-2',
    };

    const result = await service.handle(payload, body(payload), sign(payload));
    expect(result).toEqual({ received: true });
    expect(repo.setSeatStatusIfPending).toHaveBeenCalledWith(
      'A2',
      SEAT_STATUS.AVAILABLE,
      fakeClient,
    );
    const failed = auditEntries(AUDIT_EVENT.PAYMENT_FAILED);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ outcome: AUDIT_OUTCOME.FAILED, reservationId: 'res-2' });
  });

  it('atomically releases the seat and audits PAYMENT_FAILED in one transaction', async () => {
    matchReservation('res-3', 'A3');
    const payload = {
      event: PAYMENT_EVENT.FAILED,
      sessionId: 'cs_ghi',
      seatId: 'A3',
      userId: 'user-3',
    };

    await service.handle(payload, body(payload), sign(payload));

    // Everything that touched the DB ran inside tx.run (which provides the fake client).
    expect(tx.run).toHaveBeenCalledTimes(1);
    expect(repo.transitionReservation).toHaveBeenCalledWith(
      'cs_ghi',
      RESERVATION_STATUS.FAILED,
      fakeClient,
    );
    expect(repo.setSeatStatusIfPending).toHaveBeenCalledWith(
      'A3',
      SEAT_STATUS.AVAILABLE,
      fakeClient,
    );
  });

  it('updates the seat from the matched reservation, not the webhook payload', async () => {
    matchReservation('res-1', 'A1');
    const payload = {
      event: PAYMENT_EVENT.SUCCEEDED,
      sessionId: 'cs_abc',
      seatId: 'A3',
      userId: 'user-1',
    };
    await service.handle(payload, body(payload), sign(payload));
    expect(repo.setSeatStatusIfPending).toHaveBeenCalledWith(
      'A1',
      SEAT_STATUS.CONFIRMED,
      fakeClient,
    );
  });

  it('audits a stale webhook (no prior, no match) as NOOP and touches no seat', async () => {
    repo.transitionReservation.mockResolvedValue(undefined);
    const payload = {
      event: PAYMENT_EVENT.SUCCEEDED,
      sessionId: 'cs_stale',
      seatId: 'A1',
      userId: 'user-1',
    };
    const result = await service.handle(payload, body(payload), sign(payload));
    expect(result).toEqual({ received: true });
    expect(repo.setSeatStatusIfPending).not.toHaveBeenCalled();

    const noop = auditEntries(AUDIT_EVENT.PAYMENT_SUCCEEDED);
    expect(noop).toHaveLength(1);
    expect(noop[0]).toMatchObject({ outcome: AUDIT_OUTCOME.NOOP, reservationId: null });
  });

  it('short-circuits a duplicate webhook delivery as DUPLICATE_WEBHOOK / NOOP', async () => {
    mockAudit.hasPriorOutcome.mockResolvedValue(true);
    const payload = {
      event: PAYMENT_EVENT.SUCCEEDED,
      sessionId: 'cs_dup',
      seatId: 'A1',
      userId: 'user-1',
    };

    const result = await service.handle(payload, body(payload), sign(payload));
    expect(result).toEqual({ received: true });

    expect(repo.transitionReservation).not.toHaveBeenCalled();
    expect(repo.setSeatStatusIfPending).not.toHaveBeenCalled();

    expect(auditEntries(AUDIT_EVENT.WEBHOOK_RECEIVED)).toHaveLength(1);
    const dup = auditEntries(AUDIT_EVENT.DUPLICATE_WEBHOOK);
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ outcome: AUDIT_OUTCOME.NOOP, sessionId: 'cs_dup' });
    expect(auditEntries(AUDIT_EVENT.PAYMENT_SUCCEEDED)).toHaveLength(0);
  });
});
