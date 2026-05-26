import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Queryable } from '../database/queryable';
import { AuditEvent, AuditOutcome } from '../common/constants';

export interface AuditEntry {
  eventType: AuditEvent;
  outcome: AuditOutcome;
  reservationId?: string | null;
  sessionId?: string | null;
  seatId?: string | null;
  userId?: string | null;
  amount?: number | null;
  signatureValid?: boolean | null;
  rawPayload?: unknown;
}

export interface AuditWriteOptions {
  /**
   * INSERT with `ON CONFLICT DO NOTHING` keyed on `(session_id)` restricted
   * to `event_type = 'REFUND_INITIATED'` — i.e. the partial unique index
   * `ux_refund_initiated_one_per_session`.
   */
  dedupeBySession?: boolean;
}

export interface AuditRow {
  id: string;
  reservation_id: string | null;
  session_id: string | null;
  seat_id: string | null;
  user_id: string | null;
  amount: string | null;
  event_type: AuditEvent;
  outcome: AuditOutcome;
  signature_valid: boolean | null;
  raw_payload: unknown;
  created_at: Date;
}

/**
 * Append-only ledger — INSERT only. `reservations.status` is current state;
 * this table is immutable history.
 */
@Injectable()
export class PaymentAuditRepository {
  // Hard cap on persisted payload size. A misbehaving or hostile caller could
  // otherwise push arbitrarily large JSON into JSONB — bloat we can't undo on
  // an append-only table. Past the cap we keep a head-of-payload sample so the
  // row is still useful in forensics.
  private static readonly RAW_PAYLOAD_MAX_BYTES = 16 * 1024;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(
    entry: AuditEntry,
    db: Queryable = this.pool,
    options: AuditWriteOptions = {},
  ): Promise<void> {
    const onConflict = options.dedupeBySession
      ? ` ON CONFLICT (session_id) WHERE event_type = 'REFUND_INITIATED' AND session_id IS NOT NULL DO NOTHING`
      : '';

    await db.query(
      `INSERT INTO payment_transactions
         (reservation_id, session_id, seat_id, user_id, amount,
          event_type, outcome, signature_valid, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)${onConflict}`,
      [
        entry.reservationId ?? null,
        entry.sessionId ?? null,
        entry.seatId ?? null,
        entry.userId ?? null,
        entry.amount ?? null,
        entry.eventType,
        entry.outcome,
        entry.signatureValid ?? null,
        PaymentAuditRepository.encodeRawPayload(entry.rawPayload),
      ],
    );
  }

  private static encodeRawPayload(rawPayload: unknown): string | null {
    if (rawPayload === undefined) return null;
    const json = JSON.stringify(rawPayload);
    if (json.length <= PaymentAuditRepository.RAW_PAYLOAD_MAX_BYTES) return json;
    return JSON.stringify({
      truncated: true,
      originalBytes: json.length,
      sample: json.slice(0, PaymentAuditRepository.RAW_PAYLOAD_MAX_BYTES),
    });
  }

  async hasPriorOutcome(
    sessionId: string,
    outcomeEvent: AuditEvent,
    db: Queryable = this.pool,
  ): Promise<boolean> {
    const { rows } = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM payment_transactions
          WHERE session_id = $1 AND event_type = $2
       ) AS exists`,
      [sessionId, outcomeEvent],
    );
    return rows[0]?.exists === true;
  }

  async countByEvent(
    sessionId: string,
    eventType: AuditEvent,
    db: Queryable = this.pool,
  ): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM payment_transactions
        WHERE session_id = $1 AND event_type = $2`,
      [sessionId, eventType],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async findByReservation(reservationId: string, db: Queryable = this.pool): Promise<AuditRow[]> {
    const { rows } = await db.query<AuditRow>(
      `SELECT id, reservation_id, session_id, seat_id, user_id, amount,
              event_type, outcome, signature_valid, raw_payload, created_at
         FROM payment_transactions
        WHERE reservation_id = $1
        ORDER BY created_at ASC`,
      [reservationId],
    );
    return rows;
  }
}
