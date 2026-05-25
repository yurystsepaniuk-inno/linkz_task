import { Injectable, Inject } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Queryable } from '../database/queryable';
import { DELIVERY_STATUS, DeliveryStatus } from '../common/constants';

/**
 * Shape of one `webhook_deliveries` row. snake_case from pg.
 */
export interface DeliveryRecord {
  id: string;
  session_id: string;
  url: string;
  body: string;
  signature: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Outbox table data-access layer for `webhook_deliveries`. The HTTP retry +
 * backoff scheduling lives in `WebhookDeliveryService`; this class only owns
 * the SQL.
 */
@Injectable()
export class WebhookDeliveryRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async insertPending(
    sessionId: string,
    url: string,
    body: string,
    signature: string,
    db: Queryable = this.pool,
  ): Promise<DeliveryRecord> {
    const { rows } = await db.query<DeliveryRecord>(
      `INSERT INTO webhook_deliveries
         (session_id, url, body, signature, status, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, 0, NOW())
       RETURNING *`,
      [sessionId, url, body, signature, DELIVERY_STATUS.PENDING],
    );
    return rows[0];
  }

  async findById(
    deliveryId: string,
    db: Queryable = this.pool,
  ): Promise<DeliveryRecord | undefined> {
    const { rows } = await db.query<DeliveryRecord>(
      'SELECT * FROM webhook_deliveries WHERE id = $1',
      [deliveryId],
    );
    return rows[0];
  }

  /**
   * Most-recent delivery row for a session. There is one row per `pay()` call,
   * so for a given session this is just "the" delivery — ORDER BY/LIMIT is
   * defensive in case the schema ever permits more than one.
   */
  async findLatestBySession(
    sessionId: string,
    db: Queryable = this.pool,
  ): Promise<DeliveryRecord | undefined> {
    const { rows } = await db.query<DeliveryRecord>(
      `SELECT * FROM webhook_deliveries
        WHERE session_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [sessionId],
    );
    return rows[0];
  }

  /**
   * Pull every row whose `next_attempt_at` has come due and reserve them by
   * pushing `next_attempt_at` LEASE_SECONDS into the future inside one
   * transaction so a concurrent poller can't pick them up. Uses
   * `FOR UPDATE SKIP LOCKED` so multiple instances never race on the same row.
   *
   * Lease = 60s: long enough that an attempt with `fetchWithTimeout` (default
   * <30s) finishes before the lease expires, short enough that if the poller
   * crashes mid-attempt the row only sits stranded for a minute instead of
   * an hour. The poller `runAttempt` always either DELIVERS, FAILS, or
   * reschedules, so on the happy path the lease is rewritten before it ever
   * expires; the lease only matters as a crash-recovery backstop.
   */
  private static readonly LEASE_SECONDS = 60;

  async claimDueDeliveries(limit = 50): Promise<DeliveryRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<DeliveryRecord>(
        `SELECT * FROM webhook_deliveries
         WHERE status = $1 AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [DELIVERY_STATUS.PENDING, limit],
      );
      if (rows.length > 0) {
        await client.query(
          `UPDATE webhook_deliveries
           SET next_attempt_at = NOW() + make_interval(secs => $2)
           WHERE id = ANY($1::uuid[])`,
          [rows.map((r) => r.id), WebhookDeliveryRepository.LEASE_SECONDS],
        );
      }
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async markDelivered(
    id: string,
    attempts: number,
    db: Queryable = this.pool,
  ): Promise<void> {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = $1, attempts = $2, next_attempt_at = NULL, last_error = NULL, updated_at = NOW()
       WHERE id = $3`,
      [DELIVERY_STATUS.DELIVERED, attempts, id],
    );
  }

  async markFailed(
    id: string,
    attempts: number,
    error: string | null,
    db: Queryable = this.pool,
  ): Promise<void> {
    await db.query(
      `UPDATE webhook_deliveries
       SET status = $1, attempts = $2, next_attempt_at = NULL, last_error = $3, updated_at = NOW()
       WHERE id = $4`,
      [DELIVERY_STATUS.FAILED, attempts, error, id],
    );
  }

  /**
   * Reschedule a PENDING delivery for a future retry. `make_interval` builds
   * the interval from a numeric column — preferred over `($N || ' ms')::interval`
   * (string concatenation cast to a SQL data type).
   */
  async rescheduleAfter(
    id: string,
    attempts: number,
    delayMs: number,
    error: string | null,
    db: Queryable = this.pool,
  ): Promise<void> {
    await db.query(
      `UPDATE webhook_deliveries
       SET attempts = $1,
           next_attempt_at = NOW() + make_interval(secs => $2 / 1000.0),
           last_error = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [attempts, delayMs, error, id],
    );
  }
}
