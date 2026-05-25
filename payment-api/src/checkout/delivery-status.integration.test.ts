/**
 * Integration test for the buyer-facing `/delivery-status` endpoint
 * (`CheckoutController.getDeliveryStatus`).
 *
 * Mirrors the style of reservation-api's locking integration test: the test
 * speaks directly to a live Postgres `payments` database (started by
 * `docker compose up -d`) and exercises the real controller + service +
 * repository chain — no HTTP mocking, no in-memory pool. This is what would
 * catch a `findLatestBySession` SQL regression or a controller wiring mistake
 * that a pure unit test cannot.
 *
 * Requires Postgres on `${DB_HOST}:${DB_PORT}` (defaults 5433/payments).
 *
 * Run with: `npm run test:integration`
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { SessionsRepository } from './sessions.repository';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { DELIVERY_STATUS, SESSION_ID_PREFIX } from '../common/constants';

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const SEAT = 'IT_DELIVERY_SEAT';
const USER = 'IT_DELIVERY_USER';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '5433', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const config = {
  getOrThrow: (key: string): string => {
    const values: Record<string, string> = {
      PUBLIC_BASE_URL: 'http://localhost:3002',
      WEBHOOK_SECRET: 'integration-test-secret',
      RESERVATION_API_URL: 'http://reservation.invalid',
      RESERVATION_AMOUNT: '10.00',
    };
    if (!(key in values)) throw new Error(`Missing config: ${key}`);
    return values[key];
  },
} as unknown as ConfigService;

const sessionsRepo = new SessionsRepository(pool);
const deliveryRepo = new WebhookDeliveryRepository(pool);
// `WebhookDeliveryService` registers a setInterval poller on bootstrap and
// makes outbound HTTP attempts on its own; for this test we only need the
// read-side helper (`getStatusBySession`), so we instantiate without booting
// and rely on the controller calling that helper directly.
const deliveryService = new WebhookDeliveryService(deliveryRepo);
const checkoutService = new CheckoutService(sessionsRepo, config, deliveryService);
const controller = new CheckoutController(checkoutService, deliveryService);

async function cleanup() {
  await pool.query(
    `DELETE FROM webhook_deliveries
     WHERE session_id IN (SELECT id FROM checkout_sessions WHERE seat_id = $1)`,
    [SEAT],
  );
  await pool.query('DELETE FROM checkout_sessions WHERE seat_id = $1', [SEAT]);
}

beforeAll(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'sql', 'init.sql'), 'utf8');
  await pool.query(sql);
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('GET /api/checkout/sessions/:sessionId/delivery-status (live Postgres)', () => {
  it('returns 404 with SESSION_NOT_FOUND when the session id is unknown', async () => {
    await expect(
      controller.getDeliveryStatus(`${SESSION_ID_PREFIX}does-not-exist`),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns terminalDelivered=false + PENDING for a fresh delivery row', async () => {
    const { sessionId } = await sessionsRepo.create(SEAT, USER, 10);
    await deliveryRepo.insertPending(
      sessionId,
      'http://reservation.invalid/api/webhooks/payment',
      JSON.stringify({ event: 'payment.succeeded', sessionId }),
      'fakesig',
    );

    const res = await controller.getDeliveryStatus(sessionId);
    expect(res.status).toBe(DELIVERY_STATUS.PENDING);
    expect(res.terminalDelivered).toBe(false);
    expect(res.attempts).toBe(0);
    expect(res.nextAttemptAt).not.toBeNull();
  });

  it('returns terminalDelivered=true once the delivery row is marked DELIVERED', async () => {
    const { sessionId } = await sessionsRepo.create(SEAT, USER, 10);
    const record = await deliveryRepo.insertPending(
      sessionId,
      'http://reservation.invalid/api/webhooks/payment',
      JSON.stringify({ event: 'payment.succeeded', sessionId }),
      'fakesig',
    );
    await deliveryRepo.markDelivered(record.id, 1);

    const res = await controller.getDeliveryStatus(sessionId);
    expect(res.status).toBe(DELIVERY_STATUS.DELIVERED);
    expect(res.terminalDelivered).toBe(true);
    // `markDelivered` clears next_attempt_at to NULL once a row is terminal.
    expect(res.nextAttemptAt).toBeNull();
    expect(res.attempts).toBe(1);
  });

  it('returns the LATEST delivery row when more than one exists for a session', async () => {
    // The schema currently permits multiple delivery rows per session; the
    // repository's ORDER BY created_at DESC LIMIT 1 is the contract. This
    // test pins that ordering so a future schema change does not silently
    // start returning a stale row.
    const { sessionId } = await sessionsRepo.create(SEAT, USER, 10);
    const older = await deliveryRepo.insertPending(
      sessionId,
      'http://reservation.invalid/api/webhooks/payment',
      'older-body',
      'sig-old',
    );
    // Backdate the first row so created_at ordering is deterministic.
    await pool.query(
      `UPDATE webhook_deliveries SET created_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [older.id],
    );
    const newer = await deliveryRepo.insertPending(
      sessionId,
      'http://reservation.invalid/api/webhooks/payment',
      'newer-body',
      'sig-new',
    );
    await deliveryRepo.markFailed(newer.id, 5, 'exhausted');

    const res = await controller.getDeliveryStatus(sessionId);
    expect(res.status).toBe(DELIVERY_STATUS.FAILED);
    expect(res.attempts).toBe(5);
    expect(res.terminalDelivered).toBe(false);
  });
});
