import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Queryable } from '../database/queryable';
import {
  AUDIT_EVENT,
  RESERVATION_STATUS,
  RECONCILIATION_GRACE_MINUTES,
} from '../common/constants';

export interface OrphanedReservation {
  id: string;
  seat_id: string;
  user_id: string;
  session_id: string;
  created_at: Date;
}

/**
 * "Orphan" candidate query — the constants are sourced from TS so renaming
 * a status or audit event can't silently desync the SQL.
 */
@Injectable()
export class ReconciliationRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * A reservation is "orphaned" when:
   *   • it ended up EXPIRED or FAILED (we gave up on it),
   *   • it has a session_id (so a charge could exist on payment-api),
   *   • the grace window has passed (no late webhook can save it now),
   *   • we have never recorded PAYMENT_SUCCEEDED for that session,
   *   • we have not already issued a REFUND_INITIATED for it,
   *   • we have not already given up after REFUND_MAX_ATTEMPTS failures
   *     (REFUND_GAVE_UP is the terminal-failure marker — operator owns it),
   *   • the reconciliation cron has not already DISMISSED it (payment-api
   *     status was FAILED / stuck-PENDING on a previous tick — see
   *     `RECONCILIATION_DISMISSED` for why this terminator exists).
   *
   * Note: REFUND_ATTEMPT_FAILED is *not* in the exclusion list. It is a
   * transient marker recorded per failed attempt so the worker can count
   * them; the orphan must keep re-entering the candidate set until the
   * refund actually succeeds or we hit the attempt cap.
   */
  async findOrphanedReservations(db: Queryable = this.pool): Promise<OrphanedReservation[]> {
    const { rows } = await db.query<OrphanedReservation>(
      `SELECT r.id, r.seat_id, r.user_id, r.session_id, r.created_at
         FROM reservations r
        WHERE r.status = ANY($1::text[])
          AND r.session_id IS NOT NULL
          AND r.created_at < NOW() - make_interval(mins => $2)
          AND NOT EXISTS (
            SELECT 1 FROM payment_transactions pt
             WHERE pt.session_id = r.session_id
               AND pt.event_type = ANY($3::text[])
          )`,
      [
        [RESERVATION_STATUS.EXPIRED, RESERVATION_STATUS.FAILED],
        RECONCILIATION_GRACE_MINUTES,
        [
          AUDIT_EVENT.PAYMENT_SUCCEEDED,
          AUDIT_EVENT.REFUND_INITIATED,
          AUDIT_EVENT.REFUND_GAVE_UP,
          AUDIT_EVENT.RECONCILIATION_DISMISSED,
        ],
      ],
    );
    return rows;
  }
}
