import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Queryable } from '../database/queryable';
import { SESSION_STATUS } from '../common/constants';

/**
 * Data-access layer for the `CheckoutSessionExpirySweeper` cron.
 */
@Injectable()
export class CheckoutSessionExpiryRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Transition all PENDING rows whose `expires_at` has passed to EXPIRED.
   * Returns the number of rows affected.
   */
  async expireStale(db: Queryable = this.pool): Promise<number> {
    const { rowCount } = await db.query(
      `UPDATE checkout_sessions
          SET status = $1, updated_at = NOW()
        WHERE status = $2 AND expires_at <= NOW()`,
      [SESSION_STATUS.EXPIRED, SESSION_STATUS.PENDING],
    );
    return rowCount ?? 0;
  }
}
