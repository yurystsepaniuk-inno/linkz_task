import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Queryable } from '../database/queryable';
import {
  SEAT_STATUS,
  RESERVATION_STATUS,
  SeatStatus,
  ReservationStatus,
} from '../common/constants';

/**
 * Reservations + seat-state mutations (seat reads live in `SeatsRepository`).
 * Methods accept a `Queryable` so they work inside or outside a txn.
 */
@Injectable()
export class ReservationsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Must run inside a transaction — the row lock dies with `client.release()`. */
  async lockSeatForUpdate(
    seatId: string,
    db: Queryable,
  ): Promise<{ status: SeatStatus } | undefined> {
    const { rows } = await db.query<{ status: SeatStatus }>(
      'SELECT status FROM seats WHERE id = $1 FOR UPDATE',
      [seatId],
    );
    return rows[0];
  }

  async setSeatStatus(
    seatId: string,
    status: SeatStatus,
    db: Queryable = this.pool,
  ): Promise<void> {
    await db.query('UPDATE seats SET status = $1 WHERE id = $2', [status, seatId]);
  }

  async insertPendingReservation(
    seatId: string,
    userId: string,
    db: Queryable = this.pool,
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO reservations (seat_id, user_id, status, locked_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id`,
      [seatId, userId, RESERVATION_STATUS.PENDING_PAYMENT],
    );
    return rows[0].id;
  }

  async attachSessionId(
    reservationId: string,
    sessionId: string,
    db: Queryable = this.pool,
  ): Promise<void> {
    await db.query('UPDATE reservations SET session_id = $1 WHERE id = $2', [
      sessionId,
      reservationId,
    ]);
  }

  async setReservationStatus(
    reservationId: string,
    status: ReservationStatus,
    db: Queryable = this.pool,
  ): Promise<void> {
    await db.query('UPDATE reservations SET status = $1 WHERE id = $2', [
      status,
      reservationId,
    ]);
  }

  async existsForUser(
    reservationId: string,
    userId: string,
    db: Queryable = this.pool,
  ): Promise<boolean> {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM reservations WHERE id = $1 AND user_id = $2',
      [reservationId, userId],
    );
    return rows.length > 0;
  }

  /**
   * Rollback path. Both UPDATEs are guarded on `status = PENDING_PAYMENT` and
   * the seat_id comes from RETURNING on the reservation row — so if the
   * seat-expiry cron has already raced ahead and re-issued the seat to
   * another reservation, we leave it alone instead of clobbering it.
   */
  async releaseSeatAndFailReservation(
    reservationId: string,
    db: Queryable = this.pool,
  ): Promise<void> {
    const { rows } = await db.query<{ seat_id: string }>(
      `UPDATE reservations SET status = $1
        WHERE id = $2 AND status = $3
        RETURNING seat_id`,
      [RESERVATION_STATUS.FAILED, reservationId, RESERVATION_STATUS.PENDING_PAYMENT],
    );
    const seatId = rows[0]?.seat_id;
    if (!seatId) return; // already transitioned by cron / webhook — nothing to release
    await db.query(
      'UPDATE seats SET status = $1 WHERE id = $2 AND status = $3',
      [SEAT_STATUS.AVAILABLE, seatId, SEAT_STATUS.PENDING_PAYMENT],
    );
  }
}
