import { Test } from '@nestjs/testing';
import {
  ConflictException,
  BadGatewayException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReservationsService } from './reservations.service';
import { ReservationsRepository } from './reservations.repository';
import { PaymentAuditRepository } from '../audit/payment-audit.repository';
import { TransactionRunner } from '../database/transaction.runner';
import {
  SEAT_STATUS,
  RESERVATION_STATUS,
  ERROR_CODE,
  AUDIT_EVENT,
} from '../common/constants';

describe('ReservationsService', () => {
  let service: ReservationsService;
  let reservationsRepo: {
    lockSeatForUpdate: jest.Mock;
    setSeatStatus: jest.Mock;
    insertPendingReservation: jest.Mock;
    attachSessionId: jest.Mock;
    setReservationStatus: jest.Mock;
    existsForUser: jest.Mock;
    releaseSeatAndFailReservation: jest.Mock;
  };
  let mockAudit: { record: jest.Mock; hasPriorOutcome: jest.Mock; findByReservation: jest.Mock };
  let tx: { run: jest.Mock };

  const mockConfig = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'PAYMENT_API_URL') return 'http://localhost:3003';
      if (key === 'PAYMENT_API_KEY') return 'test-api-key';
      throw new Error(`Missing config: ${key}`);
    }),
  };

  // The fake client passed to repo methods inside `tx.run`. The repo is fully
  // mocked so the client only needs identity equality.
  const fakeClient = {} as never;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    reservationsRepo = {
      lockSeatForUpdate: jest.fn(),
      setSeatStatus: jest.fn().mockResolvedValue(undefined),
      insertPendingReservation: jest.fn().mockResolvedValue('res-1'),
      attachSessionId: jest.fn().mockResolvedValue(undefined),
      setReservationStatus: jest.fn().mockResolvedValue(undefined),
      existsForUser: jest.fn(),
      releaseSeatAndFailReservation: jest.fn().mockResolvedValue(undefined),
    };
    mockAudit = {
      record: jest.fn().mockResolvedValue(undefined),
      hasPriorOutcome: jest.fn().mockResolvedValue(false),
      findByReservation: jest.fn().mockResolvedValue([]),
    };
    tx = {
      run: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(fakeClient)),
    };

    const module = await Test.createTestingModule({
      providers: [
        ReservationsService,
        { provide: ReservationsRepository, useValue: reservationsRepo },
        { provide: PaymentAuditRepository, useValue: mockAudit },
        { provide: TransactionRunner, useValue: tx },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get(ReservationsService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('happy path returns checkoutUrl, sends x-api-key, and audits CHECKOUT_SESSION_CREATED', async () => {
    reservationsRepo.lockSeatForUpdate.mockResolvedValue({ status: SEAT_STATUS.AVAILABLE });

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        // payment-api is the source of truth for the amount; reservation-api
        // takes whatever value comes back in the response.
        json: async () => ({
          sessionId: 'sess_1',
          checkoutUrl: 'http://localhost:3002/checkout/sess_1',
          amount: 10,
        }),
      } as Response;
    });

    const result = await service.create({ seatId: 'A1' }, 'user-1');
    expect(result.checkoutUrl).toBe('http://localhost:3002/checkout/sess_1');
    expect(capturedHeaders['x-api-key']).toBe('test-api-key');
    // The request body MUST NOT carry an `amount` — payment-api resolves it.
    expect(capturedBody).toEqual({ seatId: 'A1', userId: 'user-1' });
    expect(reservationsRepo.attachSessionId).toHaveBeenCalledWith('res-1', 'sess_1', fakeClient);
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: AUDIT_EVENT.CHECKOUT_SESSION_CREATED,
        reservationId: 'res-1',
        sessionId: 'sess_1',
        seatId: 'A1',
        userId: 'user-1',
        amount: 10,
      }),
      fakeClient,
    );
  });

  it(`throws 409 when seat is ${SEAT_STATUS.PENDING_PAYMENT}`, async () => {
    reservationsRepo.lockSeatForUpdate.mockResolvedValue({ status: SEAT_STATUS.PENDING_PAYMENT });
    await expect(service.create({ seatId: 'A1' }, 'user-1')).rejects.toThrow(ConflictException);
    expect(reservationsRepo.insertPendingReservation).not.toHaveBeenCalled();
  });

  it(`throws 409 when seat is ${SEAT_STATUS.CONFIRMED}`, async () => {
    reservationsRepo.lockSeatForUpdate.mockResolvedValue({ status: SEAT_STATUS.CONFIRMED });

    await expect(service.create({ seatId: 'A1' }, 'user-1')).rejects.toThrow(
      new ConflictException(ERROR_CODE.SEAT_ALREADY_OCCUPIED),
    );
  });

  it('compensates and throws 502 when payment api fails', async () => {
    reservationsRepo.lockSeatForUpdate.mockResolvedValue({ status: SEAT_STATUS.AVAILABLE });
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('network error'));

    await expect(service.create({ seatId: 'A1' }, 'user-1')).rejects.toThrow(BadGatewayException);
    expect(reservationsRepo.releaseSeatAndFailReservation).toHaveBeenCalledWith(
      'res-1',
      fakeClient,
    );
    // The atomic rollback used the repo, not two separate UPDATEs.
    expect(reservationsRepo.releaseSeatAndFailReservation).toHaveBeenCalledTimes(1);
    // Sanity: rollback path advances reservation to FAILED via the repo's helper.
    // (No direct setReservationStatus call on the failure path — release+fail is one method.)
    expect(reservationsRepo.setReservationStatus).not.toHaveBeenCalledWith(
      'res-1',
      RESERVATION_STATUS.FAILED,
    );
  });

  describe('getAudit', () => {
    it('returns the audit trail for a reservation owned by the caller', async () => {
      reservationsRepo.existsForUser.mockResolvedValueOnce(true);
      const trail = [{ id: 'txn-1', event_type: AUDIT_EVENT.CHECKOUT_SESSION_CREATED }];
      mockAudit.findByReservation.mockResolvedValueOnce(trail);

      await expect(service.getAudit('res-1', 'user-1')).resolves.toBe(trail);
      expect(reservationsRepo.existsForUser).toHaveBeenCalledWith('res-1', 'user-1');
      expect(mockAudit.findByReservation).toHaveBeenCalledWith('res-1');
    });

    it('throws 404 when the reservation does not exist or is not the caller’s', async () => {
      reservationsRepo.existsForUser.mockResolvedValueOnce(false);

      await expect(service.getAudit('res-1', 'someone-else')).rejects.toThrow(NotFoundException);
      expect(mockAudit.findByReservation).not.toHaveBeenCalled();
    });
  });
});
