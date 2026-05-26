import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Queryable } from '../database/queryable';
import { SEAT_STATUS, RESERVATION_STATUS, RESERVATION_LOCK_TTL_MINUTES } from '../common/constants';

export interface ExpiredReservation {
  id: string;
  seat_id: string;
  user_id: string;
  session_id: string | null;
}

@Injectable()
export class SeatExpiryRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async expireStaleReservations(db: Queryable): Promise<ExpiredReservation[]> {
    const { rows } = await db.query<ExpiredReservation>(
      `UPDATE reservations SET status = $1
        WHERE status = $2
          AND locked_at < NOW() - make_interval(mins => $3)
        RETURNING id, seat_id, user_id, session_id`,
      [
        RESERVATION_STATUS.EXPIRED,
        RESERVATION_STATUS.PENDING_PAYMENT,
        RESERVATION_LOCK_TTL_MINUTES,
      ],
    );
    return rows;
  }

  /** Guarded on `status = PENDING_PAYMENT` so an invariant violation can't
   *  turn this release into a clobber of a CONFIRMED seat. */
  async releaseSeats(seatIds: string[], db: Queryable): Promise<void> {
    if (seatIds.length === 0) return;
    await db.query('UPDATE seats SET status = $1 WHERE id = ANY($2::text[]) AND status = $3', [
      SEAT_STATUS.AVAILABLE,
      seatIds,
      SEAT_STATUS.PENDING_PAYMENT,
    ]);
  }
}
