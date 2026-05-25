import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Queryable } from '../database/queryable';
import { RefundStatus } from '../common/constants';

export interface RefundRow {
  id: string;
  session_id: string;
  amount: string;
  reason: string | null;
  status: RefundStatus;
  created_at: Date;
}

/**
 * Idempotency lives in `UNIQUE (session_id)` — the `ON CONFLICT DO UPDATE`
 * below is the trick that lets a duplicate INSERT still return its row.
 */
@Injectable()
export class RefundsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findBySession(
    sessionId: string,
    db: Queryable = this.pool,
  ): Promise<RefundRow | undefined> {
    const { rows } = await db.query<RefundRow>(
      'SELECT * FROM refunds WHERE session_id = $1',
      [sessionId],
    );
    return rows[0];
  }

  /** `DO UPDATE SET session_id = EXCLUDED.session_id` is a no-op write — its
   *  only job is to make RETURNING fire on the conflict branch. */
  async upsert(
    sessionId: string,
    amount: number,
    reason: string | null,
    status: RefundStatus,
    db: Queryable = this.pool,
  ): Promise<RefundRow> {
    const { rows } = await db.query<RefundRow>(
      `INSERT INTO refunds (session_id, amount, reason, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id) DO UPDATE SET session_id = EXCLUDED.session_id
       RETURNING *`,
      [sessionId, amount, reason, status],
    );
    return rows[0];
  }
}
