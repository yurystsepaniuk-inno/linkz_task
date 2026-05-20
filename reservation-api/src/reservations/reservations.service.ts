import {
  Injectable,
  Inject,
  Logger,
  ConflictException,
  BadGatewayException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { CreateReservationDto } from './reservation.dto';
import { SEAT_STATUS, RESERVATION_STATUS, ERROR_CODE, API_KEY_HEADER } from '../common/constants';
import { MESSAGES } from '../common/messages';

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);
  private readonly paymentApiUrl: string;
  private readonly paymentApiKey: string;
  private readonly reservationAmount: number;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    config: ConfigService,
  ) {
    this.paymentApiUrl = config.getOrThrow<string>('PAYMENT_API_URL');
    this.paymentApiKey = config.getOrThrow<string>('PAYMENT_API_KEY');
    this.reservationAmount = parseFloat(config.getOrThrow<string>('RESERVATION_AMOUNT'));
  }

  async create(
    dto: CreateReservationDto,
    userId: string,
  ): Promise<{ checkoutUrl: string }> {
    const client = await this.pool.connect();
    let reservationId!: string;
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM seats WHERE id = $1 FOR UPDATE',
        [dto.seatId],
      );

      const seat = rows[0];
      if (!seat || seat.status !== SEAT_STATUS.AVAILABLE) {
        await client.query('ROLLBACK');
        throw new ConflictException(ERROR_CODE.SEAT_ALREADY_OCCUPIED);
      }

      await client.query(
        'UPDATE seats SET status = $1 WHERE id = $2',
        [SEAT_STATUS.PENDING_PAYMENT, dto.seatId],
      );

      const resResult = await client.query<{ id: string }>(
        'INSERT INTO reservations (seat_id, user_id, status, locked_at) VALUES ($1, $2, $3, NOW()) RETURNING id',
        [dto.seatId, userId, RESERVATION_STATUS.PENDING_PAYMENT],
      );
      reservationId = resResult.rows[0].id;

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    try {
      const response = await fetch(`${this.paymentApiUrl}/api/checkout/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [API_KEY_HEADER]: this.paymentApiKey },
        body: JSON.stringify({ seatId: dto.seatId, userId, amount: this.reservationAmount }),
      });

      if (!response.ok) throw new Error(MESSAGES.reservations.paymentApiError);

      const data = (await response.json()) as { sessionId: string; checkoutUrl: string };
      await this.pool.query(
        'UPDATE reservations SET session_id = $1 WHERE id = $2',
        [data.sessionId, reservationId],
      );
      return { checkoutUrl: data.checkoutUrl };
    } catch (err) {
      this.logger.error(`Payment API call failed for seat ${dto.seatId}; releasing lock`, err);
      await this.pool.query(
        'UPDATE seats SET status = $1 WHERE id = $2',
        [SEAT_STATUS.AVAILABLE, dto.seatId],
      );
      await this.pool.query(
        'UPDATE reservations SET status = $1 WHERE id = $2',
        [RESERVATION_STATUS.FAILED, reservationId],
      );
      throw new BadGatewayException(MESSAGES.reservations.paymentServiceUnavailable);
    }
  }
}
