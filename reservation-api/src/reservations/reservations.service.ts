import {
  Injectable,
  Logger,
  ConflictException,
  BadGatewayException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateReservationDto } from './reservation.dto';
import {
  SEAT_STATUS,
  ERROR_CODE,
  API_KEY_HEADER,
  AUDIT_EVENT,
  AUDIT_OUTCOME,
} from '../common/constants';
import { MESSAGES } from '../common/messages';
import {
  PaymentAuditRepository,
  AuditRow,
} from '../audit/payment-audit.repository';
import { ReservationsRepository } from './reservations.repository';
import { TransactionRunner } from '../database/transaction.runner';
import { fetchWithTimeout } from '../common/http';
import { withSpan } from '../observability/tracer';
import {
  reservationsTotal,
  reservationDuration,
  recordDuration,
} from '../observability/metrics';

/**
 * `conflict` (seat already taken) is a successful business outcome and only
 * `failed` counts against the SLO error budget. Reflected in the dashboard's
 * numerator definition.
 */
type ReservationOutcome = 'confirmed' | 'conflict' | 'failed';

interface CheckoutSession {
  sessionId: string;
  checkoutUrl: string;
  amount: number;
}

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly reservations: ReservationsRepository,
    private readonly audit: PaymentAuditRepository,
    private readonly tx: TransactionRunner,
    private readonly config: ConfigService,
  ) {}

  /**
   * Steps: lock seat → create checkout session → attach session_id +
   * audit → metric. The payment-api call deliberately happens *after* the
   * lock commits so the row lock is never held across a network round-trip.
   */
  async create(
    dto: CreateReservationDto,
    userId: string,
  ): Promise<{ checkoutUrl: string }> {
    const started = process.hrtime.bigint();
    return withSpan(
      'reservation.create',
      { 'seat.id': dto.seatId, 'user.id': userId },
      async (rootSpan) => {
        const reservationId = await this.lockSeatTrackingOutcome(dto, userId, started);
        rootSpan.setAttribute('reservation.id', reservationId);

        try {
          const session = await this.createCheckoutSession(dto, userId);
          await this.recordSessionOnReservation(reservationId, session, dto, userId);
          this.emitReservationOutcome(started, 'confirmed');
          return { checkoutUrl: session.checkoutUrl };
        } catch (err) {
          this.logger.error(
            `Payment API call failed for seat ${dto.seatId}; releasing lock`,
            err,
          );
          await this.releaseLockAndMarkFailed(reservationId);
          this.emitReservationOutcome(started, 'failed');
          throw new BadGatewayException(MESSAGES.reservations.paymentServiceUnavailable);
        }
      },
    );
  }

  /** Owner-scoped — anyone else (or an unknown id) gets a 404, not a 403,
   *  so we don't leak which reservation ids exist. */
  async getAudit(reservationId: string, userId: string): Promise<AuditRow[]> {
    const owned = await this.reservations.existsForUser(reservationId, userId);
    if (!owned) {
      throw new NotFoundException(MESSAGES.reservations.notFound);
    }
    return this.audit.findByReservation(reservationId);
  }

  // --- step helpers -------------------------------------------------------

  private async lockSeatTrackingOutcome(
    dto: CreateReservationDto,
    userId: string,
    started: bigint,
  ): Promise<string> {
    try {
      return await this.lockSeat(dto, userId);
    } catch (err) {
      const outcome: ReservationOutcome =
        err instanceof ConflictException ? 'conflict' : 'failed';
      this.emitReservationOutcome(started, outcome);
      throw err;
    }
  }

  /**
   * Both the FOR UPDATE lock *and* the partial unique index
   * `reservations_one_pending_per_seat` produce a 409 here — the SQLSTATE
   * 23505 mapping is what stops a missed-lock regression from leaking 500s.
   */
  private async lockSeat(dto: CreateReservationDto, userId: string): Promise<string> {
    return withSpan(
      'reservation.lock_seat',
      { 'seat.id': dto.seatId },
      async (span) => {
        try {
          return await this.tx.run(async (client) => {
            const seat = await this.reservations.lockSeatForUpdate(dto.seatId, client);
            if (!seat || seat.status !== SEAT_STATUS.AVAILABLE) {
              throw new ConflictException(ERROR_CODE.SEAT_ALREADY_OCCUPIED);
            }
            await this.reservations.setSeatStatus(
              dto.seatId,
              SEAT_STATUS.PENDING_PAYMENT,
              client,
            );
            const newId = await this.reservations.insertPendingReservation(
              dto.seatId,
              userId,
              client,
            );
            span.setAttribute('reservation.id', newId);
            return newId;
          });
        } catch (err) {
          if ((err as { code?: string })?.code === '23505') {
            throw new ConflictException(ERROR_CODE.SEAT_ALREADY_OCCUPIED);
          }
          throw err;
        }
      },
    );
  }

  /** payment-api is the sole price authority — we send seat+user and read the
   *  resolved amount back from the response (no local RESERVATION_AMOUNT). */
  private async createCheckoutSession(
    dto: CreateReservationDto,
    userId: string,
  ): Promise<CheckoutSession> {
    const paymentApiUrl = this.config.getOrThrow<string>('PAYMENT_API_URL');
    const paymentApiKey = this.config.getOrThrow<string>('PAYMENT_API_KEY');
    return withSpan(
      'payment_api.create_session',
      {
        'seat.id': dto.seatId,
        'http.url': `${paymentApiUrl}/api/checkout/sessions`,
      },
      async (span) => {
        const response = await fetchWithTimeout(`${paymentApiUrl}/api/checkout/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [API_KEY_HEADER]: paymentApiKey,
          },
          body: JSON.stringify({
            seatId: dto.seatId,
            userId,
          }),
        });
        span.setAttribute('http.status_code', response.status);

        if (!response.ok) throw new Error(MESSAGES.reservations.paymentApiError);

        const parsed = (await response.json()) as CheckoutSession;
        span.setAttribute('session.id', parsed.sessionId);
        return parsed;
      },
    );
  }

  /** session_id attach + audit row commit together — partial-failure
   *  would leave the ledger and `reservations` out of sync. */
  private async recordSessionOnReservation(
    reservationId: string,
    session: CheckoutSession,
    dto: CreateReservationDto,
    userId: string,
  ): Promise<void> {
    await this.tx.run(async (client) => {
      await this.reservations.attachSessionId(reservationId, session.sessionId, client);
      await this.audit.record(
        {
          eventType: AUDIT_EVENT.CHECKOUT_SESSION_CREATED,
          outcome: AUDIT_OUTCOME.SUCCESS,
          reservationId,
          sessionId: session.sessionId,
          seatId: dto.seatId,
          userId,
          amount: session.amount,
          rawPayload: {
            sessionId: session.sessionId,
            checkoutUrl: session.checkoutUrl,
            amount: session.amount,
          },
        },
        client,
      );
    });
  }

  /** Rollback when the payment-api call fails after the seat was locked.
   *  Guards in the repo ensure we can't release a seat that the cron or a
   *  late webhook has since reassigned. */
  private async releaseLockAndMarkFailed(reservationId: string): Promise<void> {
    await this.tx.run(async (client) => {
      await this.reservations.releaseSeatAndFailReservation(reservationId, client);
    });
  }

  /** Called exactly once per `create()` exit path so the counter and
   *  histogram never disagree about which outcome fired. */
  private emitReservationOutcome(started: bigint, outcome: ReservationOutcome): void {
    reservationsTotal.add(1, { outcome });
    recordDuration(reservationDuration, started);
  }
}
