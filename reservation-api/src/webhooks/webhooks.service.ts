import {
  Injectable,
  Inject,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { createHmac, timingSafeEqual } from 'crypto';
import { PG_POOL } from '../database/database.module';
import {
  PAYMENT_EVENT,
  SEAT_STATUS,
  RESERVATION_STATUS,
  PaymentEvent,
  ReservationStatus,
  SeatStatus,
} from '../common/constants';
import { MESSAGES } from '../common/messages';

export interface WebhookPayload {
  event: PaymentEvent;
  sessionId: string;
  seatId: string;
  userId: string;
}

@Injectable()
export class WebhooksService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {}

  verifySignature(rawBody: Buffer, signature: string): void {
    const secret = this.config.getOrThrow<string>('WEBHOOK_SECRET');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new UnauthorizedException(MESSAGES.webhooks.invalidSignature);
    }
  }

  async handle(payload: WebhookPayload): Promise<{ received: boolean }> {
    let reservationStatus: ReservationStatus;
    let seatStatus: SeatStatus;
    switch (payload.event) {
      case PAYMENT_EVENT.SUCCEEDED:
        reservationStatus = RESERVATION_STATUS.CONFIRMED;
        seatStatus = SEAT_STATUS.CONFIRMED;
        break;
      case PAYMENT_EVENT.FAILED:
        reservationStatus = RESERVATION_STATUS.FAILED;
        seatStatus = SEAT_STATUS.AVAILABLE;
        break;
      default:
        throw new BadRequestException(MESSAGES.webhooks.unknownEvent);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ seat_id: string }>(
        'UPDATE reservations SET status = $1 WHERE session_id = $2 AND status = $3 RETURNING seat_id',
        [reservationStatus, payload.sessionId, RESERVATION_STATUS.PENDING_PAYMENT],
      );

      // Only touch the seat when this webhook matched a live PENDING_PAYMENT
      // reservation. A stale or duplicate event matches no row, so the seat —
      // which may now belong to a different user — is left untouched. The
      // seat_id comes from the matched reservation, never from the payload.
      if (rows[0]) {
        await client.query(
          'UPDATE seats SET status = $1 WHERE id = $2 AND status = $3',
          [seatStatus, rows[0].seat_id, SEAT_STATUS.PENDING_PAYMENT],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { received: true };
  }
}
