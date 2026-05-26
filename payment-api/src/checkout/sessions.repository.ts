import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Queryable } from '../database/queryable';
import {
  SESSION_STATUS,
  SESSION_ID_PREFIX,
  SESSION_TTL_MS,
  SessionStatus,
} from '../common/constants';

export interface CheckoutSession {
  seatId: string;
  userId: string;
  amount: number;
  status: SessionStatus;
  /** Unix epoch ms. Public domain type stays camelCase; the column is `expires_at TIMESTAMPTZ`. */
  expiresAt: number;
}

interface SessionRow {
  id: string;
  seat_id: string;
  user_id: string;
  amount: string; // NUMERIC comes back as a string from pg
  status: SessionStatus;
  expires_at: Date;
}

const rowToSession = (row: SessionRow): CheckoutSession => ({
  seatId: row.seat_id,
  userId: row.user_id,
  amount: Number(row.amount),
  status: row.status,
  expiresAt: row.expires_at.getTime(),
});

/**
 * Persistent session store — sessions survive restarts and can be served from
 * any instance. `tryClaim` is the atomic single-use guard for `pay()`.
 */
@Injectable()
export class SessionsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(
    seatId: string,
    userId: string,
    amount: number,
    db: Queryable = this.pool,
  ): Promise<{ sessionId: string }> {
    const sessionId = `${SESSION_ID_PREFIX}${randomUUID()}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.query(
      `INSERT INTO checkout_sessions
         (id, seat_id, user_id, amount, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, seatId, userId, amount, SESSION_STATUS.PENDING, expiresAt],
    );
    return { sessionId };
  }

  /** Filters at SELECT time — reads stay side-effect-free so any replica can
   *  serve them. The status sweeper handles the actual PENDING → EXPIRED move. */
  async get(sessionId: string, db: Queryable = this.pool): Promise<CheckoutSession | undefined> {
    const { rows } = await db.query<SessionRow>(
      `SELECT id, seat_id, user_id, amount, status, expires_at
         FROM checkout_sessions
        WHERE id = $1 AND expires_at > NOW()`,
      [sessionId],
    );
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  /**
   * Cheap existence probe — no payload returned. Used by the unauthenticated
   * delivery-status endpoint to 404 on guessed-bad ids without bringing the
   * full session row through the service layer.
   */
  async exists(sessionId: string, db: Queryable = this.pool): Promise<boolean> {
    const { rows } = await db.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM checkout_sessions WHERE id = $1) AS exists',
      [sessionId],
    );
    return rows[0]?.exists === true;
  }

  /** No TTL filter — settled rows (PAID/FAILED/EXPIRED) are the canonical
   *  history and must remain visible past the buyer-facing TTL for
   *  reconciliation, refunds, and `pay()` 404-vs-400 disambiguation. */
  async getInternal(
    sessionId: string,
    db: Queryable = this.pool,
  ): Promise<CheckoutSession | undefined> {
    const { rows } = await db.query<SessionRow>(
      `SELECT id, seat_id, user_id, amount, status, expires_at
         FROM checkout_sessions
        WHERE id = $1`,
      [sessionId],
    );
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  /** Atomic single-use guard — two concurrent `pay()` calls can never both
   *  claim a PENDING session, even across replicas. */
  async tryClaim(
    sessionId: string,
    finalStatus: SessionStatus,
    db: Queryable = this.pool,
  ): Promise<CheckoutSession | undefined> {
    const { rows } = await db.query<SessionRow>(
      `UPDATE checkout_sessions
          SET status = $2, updated_at = NOW()
        WHERE id = $1 AND status = $3 AND expires_at > NOW()
        RETURNING id, seat_id, user_id, amount, status, expires_at`,
      [sessionId, finalStatus, SESSION_STATUS.PENDING],
    );
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }
}
