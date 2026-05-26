/**
 * Concurrency integration test for seat-reservation locking (requirement #3).
 *
 * Unlike `reservations.service.spec.ts` (pure unit test, mocked pg pool), this
 * exercises the real `ReservationsService` against a *live* PostgreSQL, so the
 * `SELECT ... FOR UPDATE` row lock and the `reservations_one_pending_per_seat`
 * partial unique index are genuinely tested — not mocked away.
 *
 * Requires Postgres to be running (`docker compose up -d`). The outbound
 * payment-API call is mocked, since it happens *after* COMMIT and is irrelevant
 * to the locking proof — no payment-api process is needed.
 *
 * Run with: `npm run test:integration`
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { ReservationsRepository } from './reservations.repository';
import { PaymentAuditRepository } from '../audit/payment-audit.repository';
import { TransactionRunner } from '../database/transaction.runner';
import { SEAT_STATUS, RESERVATION_STATUS } from '../common/constants';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const SEAT = 'IT_SEAT'; // dedicated seat id so the demo seats (A1–A3) are untouched

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Minimal ConfigService stand-in — only the keys the service reads.
const config = {
  getOrThrow: (key: string): string => {
    const values: Record<string, string> = {
      PAYMENT_API_URL: 'http://payment.invalid',
      PAYMENT_API_KEY: 'integration-test-key',
    };
    if (!(key in values)) throw new Error(`Missing config: ${key}`);
    return values[key];
  },
} as unknown as ConfigService;

// Manual wiring: the Nest module DI graph would normally provide these, but
// the integration test instantiates the service directly against a live pool.
const reservationsRepo = new ReservationsRepository(pool);
const auditRepo = new PaymentAuditRepository(pool);
const tx = new TransactionRunner(pool);
const service = new ReservationsService(reservationsRepo, auditRepo, tx, config);

beforeAll(async () => {
  // Apply the schema so the test is self-sufficient even before `npm run
  // migrate` — this also confirms init.sql is idempotent.
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'sql', 'init.sql'), 'utf8');
  await pool.query(sql);
});

beforeEach(async () => {
  // payment_transactions has an FK to reservations — clear it first.
  await pool.query('DELETE FROM payment_transactions WHERE seat_id = $1', [SEAT]);
  await pool.query('DELETE FROM reservations WHERE seat_id = $1', [SEAT]);
  await pool.query(
    `INSERT INTO seats (id, status) VALUES ($1, 'AVAILABLE')
     ON CONFLICT (id) DO UPDATE SET status = 'AVAILABLE'`,
    [SEAT],
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM payment_transactions WHERE seat_id = $1', [SEAT]);
  await pool.query('DELETE FROM reservations WHERE seat_id = $1', [SEAT]);
  await pool.query('DELETE FROM seats WHERE id = $1', [SEAT]);
  await pool.end();
});

describe('seat-reservation locking (live Postgres)', () => {
  it('serializes two concurrent reservations: exactly one 201, one 409', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessionId: 'sess_it',
        checkoutUrl: 'http://localhost:3002/checkout/sess_it',
        amount: 10,
      }),
    }) as unknown as typeof fetch;

    const results = await Promise.allSettled([
      service.create({ seatId: SEAT }, 'user-A'),
      service.create({ seatId: SEAT }, 'user-B'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    // The database ends in a consistent state: exactly one PENDING_PAYMENT
    // reservation, and the seat itself locked to that booking.
    const { rows } = await pool.query<{ status: string }>(
      'SELECT status FROM reservations WHERE seat_id = $1',
      [SEAT],
    );
    expect(rows.filter((r) => r.status === RESERVATION_STATUS.PENDING_PAYMENT)).toHaveLength(1);

    const seat = await pool.query<{ status: string }>('SELECT status FROM seats WHERE id = $1', [
      SEAT,
    ]);
    expect(seat.rows[0].status).toBe(SEAT_STATUS.PENDING_PAYMENT);
  });

  it('partial unique index rejects a second PENDING_PAYMENT row for the same seat', async () => {
    // Bypass the service lock entirely and INSERT directly — this proves the
    // database-level backstop independently of the FOR UPDATE application lock.
    await pool.query(
      `INSERT INTO reservations (seat_id, user_id, status, locked_at)
       VALUES ($1, 'user-A', 'PENDING_PAYMENT', NOW())`,
      [SEAT],
    );

    await expect(
      pool.query(
        `INSERT INTO reservations (seat_id, user_id, status, locked_at)
         VALUES ($1, 'user-B', 'PENDING_PAYMENT', NOW())`,
        [SEAT],
      ),
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation

    // A terminal reservation does not occupy the partial index, so the seat
    // can be re-reserved once the prior one settles.
    await pool.query("UPDATE reservations SET status = 'EXPIRED' WHERE seat_id = $1", [SEAT]);
    await expect(
      pool.query(
        `INSERT INTO reservations (seat_id, user_id, status, locked_at)
         VALUES ($1, 'user-C', 'PENDING_PAYMENT', NOW())`,
        [SEAT],
      ),
    ).resolves.toBeDefined();
  });

  it('the partial unique index exists in the schema', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'reservations_one_pending_per_seat'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("status = 'PENDING_PAYMENT'");
  });
});
