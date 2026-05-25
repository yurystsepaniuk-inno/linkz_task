import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Queryable } from '../database/queryable';
import {
  RESERVATION_STATUS,
  SEAT_STATUS,
  ReservationStatus,
  SeatStatus,
} from '../common/constants';

export interface MatchedReservation {
  id: string;
  seat_id: string;
}

/**
 * Data-access layer for webhook handling. The state-changing UPDATEs are
 * anchored to `(session_id, status='PENDING_PAYMENT')` so a stale/late
 * webhook from a previous booking matches no row and the seat — which may
 * now belong to a different user — is left untouched.
 */
@Injectable()
export class WebhooksRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Try to transition a PENDING_PAYMENT reservation to its terminal status
   * keyed on `session_id`. Returns the matched row (id + seat_id) or
   * undefined if the webhook was stale / no live reservation existed.
   */
  async transitionReservation(
    sessionId: string,
    newStatus: ReservationStatus,
    db: Queryable,
  ): Promise<MatchedReservation | undefined> {
    const { rows } = await db.query<MatchedReservation>(
      `UPDATE reservations SET status = $1
        WHERE session_id = $2 AND status = $3
        RETURNING id, seat_id`,
      [newStatus, sessionId, RESERVATION_STATUS.PENDING_PAYMENT],
    );
    return rows[0];
  }

  /**
   * Set the seat status — but only if it's still PENDING_PAYMENT (defense
   * against a stale event flipping a seat that's been re-booked).
   */
  async setSeatStatusIfPending(
    seatId: string,
    newStatus: SeatStatus,
    db: Queryable,
  ): Promise<void> {
    await db.query('UPDATE seats SET status = $1 WHERE id = $2 AND status = $3', [
      newStatus,
      seatId,
      SEAT_STATUS.PENDING_PAYMENT,
    ]);
  }
}
