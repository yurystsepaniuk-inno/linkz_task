import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WebhookDeliveryService } from './webhook-delivery.service';
import {
  WebhookDeliveryRepository,
  DeliveryRecord,
} from './webhook-delivery.repository';
import { WEBHOOK_DELIVERY, DELIVERY_STATUS, SIGNATURE_HEADER } from '../common/constants';

/**
 * In-memory fake of `WebhookDeliveryRepository`. The service is the unit
 * under test — we drive it with deterministic repo behavior so the assertions
 * focus on retry/backoff/lifecycle rather than SQL surface.
 *
 * Time is ignored: `claimDueDeliveries()` returns *all* PENDING rows. The
 * tests drive the poller manually, one retry round per call, instead of
 * relying on setInterval + fake-timer arithmetic over the exponential
 * backoff schedule.
 */
function buildFakeRepo() {
  const rows = new Map<string, DeliveryRecord>();

  return {
    _rows: rows,
    insertPending: jest.fn(async (sessionId: string, url: string, body: string, signature: string) => {
      const now = new Date();
      const record: DeliveryRecord = {
        id: randomUUID(),
        session_id: sessionId,
        url,
        body,
        signature,
        status: DELIVERY_STATUS.PENDING,
        attempts: 0,
        next_attempt_at: now,
        last_error: null,
        created_at: now,
        updated_at: now,
      };
      rows.set(record.id, record);
      return { ...record };
    }),
    findById: jest.fn(async (id: string) => {
      const r = rows.get(id);
      return r ? { ...r } : undefined;
    }),
    claimDueDeliveries: jest.fn(async () => {
      return [...rows.values()]
        .filter((r) => r.status === DELIVERY_STATUS.PENDING)
        .map((r) => ({ ...r }));
    }),
    markDelivered: jest.fn(async (id: string, attempts: number) => {
      const r = rows.get(id);
      if (r) Object.assign(r, {
        status: DELIVERY_STATUS.DELIVERED,
        attempts,
        next_attempt_at: null,
        last_error: null,
        updated_at: new Date(),
      });
    }),
    markFailed: jest.fn(async (id: string, attempts: number, error: string | null) => {
      const r = rows.get(id);
      if (r) Object.assign(r, {
        status: DELIVERY_STATUS.FAILED,
        attempts,
        next_attempt_at: null,
        last_error: error,
        updated_at: new Date(),
      });
    }),
    rescheduleAfter: jest.fn(async (id: string, attempts: number, _delayMs: number, error: string | null) => {
      const r = rows.get(id);
      if (r) Object.assign(r, {
        attempts,
        next_attempt_at: new Date(),
        last_error: error,
        updated_at: new Date(),
      });
    }),
  };
}

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let repo: ReturnType<typeof buildFakeRepo>;

  beforeEach(async () => {
    // The retry tests deliberately exhaust deliveries, which the service
    // logs at WARN/ERROR by design. Suppress them so a green run doesn't
    // print scary-looking lines; outcomes are asserted via `getStatus()`.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    repo = buildFakeRepo();
    const module = await Test.createTestingModule({
      providers: [
        WebhookDeliveryService,
        { provide: WebhookDeliveryRepository, useValue: repo },
      ],
    }).compile();
    service = module.get(WebhookDeliveryService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** One synchronous "the poller fires" tick. */
  const tick = () => service.drainDue();

  it('returns deliveredOnFirstAttempt=true and DELIVERED when the first POST is 2xx', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);

    const handle = await service.deliver('http://x/webhook', '{"a":1}', 'sig-hex', 'cs_1');

    expect(handle.deliveredOnFirstAttempt).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)[SIGNATURE_HEADER]).toBe('sig-hex');
    expect(init.body).toBe('{"a":1}');

    const record = await service.getStatus(handle.deliveryId);
    expect(record).toMatchObject({
      status: DELIVERY_STATUS.DELIVERED,
      attempts: 1,
      last_error: null,
    });
  });

  it('returns deliveredOnFirstAttempt=false and retries until success on the poller tick', async () => {
    let calls = 0;
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      calls += 1;
      // Fail the first two attempts, succeed on the third.
      return { ok: calls >= 3, status: calls >= 3 ? 200 : 500 } as Response;
    });

    const handle = await service.deliver('http://x', 'body', 'sig', 'cs_2');
    expect(handle.deliveredOnFirstAttempt).toBe(false);
    expect(await service.getStatus(handle.deliveryId)).toMatchObject({
      status: DELIVERY_STATUS.PENDING,
      attempts: 1,
    });

    await tick(); // attempt 2 — still 500, reschedules
    expect(await service.getStatus(handle.deliveryId)).toMatchObject({
      status: DELIVERY_STATUS.PENDING,
      attempts: 2,
    });

    await tick(); // attempt 3 — 200, marks delivered
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(await service.getStatus(handle.deliveryId)).toMatchObject({
      status: DELIVERY_STATUS.DELIVERED,
      attempts: 3,
      last_error: null,
    });
  });

  it('marks the record FAILED after maxAttempts and stops retrying', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);

    const handle = await service.deliver('http://x', 'body', 'sig', 'cs_3');
    expect(handle.deliveredOnFirstAttempt).toBe(false);

    // First attempt happened synchronously in deliver(); drive the rest.
    for (let i = 1; i < WEBHOOK_DELIVERY.maxAttempts; i++) {
      await tick();
    }

    expect(fetchSpy).toHaveBeenCalledTimes(WEBHOOK_DELIVERY.maxAttempts);
    expect(await service.getStatus(handle.deliveryId)).toMatchObject({
      status: DELIVERY_STATUS.FAILED,
      attempts: WEBHOOK_DELIVERY.maxAttempts,
      last_error: 'HTTP 503',
    });

    // Further ticks must not produce extra fetch calls — FAILED rows are
    // not picked up by the poller.
    await tick();
    expect(fetchSpy).toHaveBeenCalledTimes(WEBHOOK_DELIVERY.maxAttempts);
  });

  it('records network errors with the thrown message and retries them', async () => {
    let calls = 0;
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200 } as Response;
    });

    const handle = await service.deliver('http://x', 'body', 'sig', 'cs_4');
    expect(handle.deliveredOnFirstAttempt).toBe(false);
    expect((await service.getStatus(handle.deliveryId))?.last_error).toBe('ECONNREFUSED');

    await tick();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await service.getStatus(handle.deliveryId)).toMatchObject({
      status: DELIVERY_STATUS.DELIVERED,
      attempts: 2,
    });
  });

  it('survives an unrelated drainDue tick when there is nothing to do', async () => {
    // No deliveries created yet — drainDue should be a clean no-op.
    await expect(service.drainDue()).resolves.toBeUndefined();
    expect(repo.claimDueDeliveries).toHaveBeenCalled();
  });
});
