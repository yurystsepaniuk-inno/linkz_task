import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import {
  WebhookDeliveryRepository,
  DeliveryRecord,
} from './webhook-delivery.repository';
import {
  WEBHOOK_DELIVERY,
  SIGNATURE_HEADER,
} from '../common/constants';
import { fetchWithTimeout } from '../common/http';
import { withSpan } from '../observability/tracer';
import {
  webhookDeliveryAttemptsTotal,
  webhookDeliveryFinalTotal,
} from '../observability/metrics';

export interface DeliveryHandle {
  deliveryId: string;
  /** True iff the synchronous first attempt already returned 2xx. */
  deliveredOnFirstAttempt: boolean;
}

/**
 * Outbox dispatcher. The first attempt fires synchronously inside `deliver()`
 * so `POST /pay` can return an honest `webhookDelivered` flag; subsequent
 * retries are driven by the `setInterval` poller that runs across restarts.
 */
@Injectable()
export class WebhookDeliveryService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private pollTimer: NodeJS.Timeout | null = null;
  /** Reentry guard — prevents two `drainDue()` runs from overlapping when a
   *  tick takes longer than POLL_INTERVAL_MS (slow HTTP, large backlog). */
  private draining = false;

  private static readonly POLL_INTERVAL_MS = 500;

  constructor(private readonly repo: WebhookDeliveryRepository) {}

  onApplicationBootstrap() {
    this.pollTimer = setInterval(() => {
      void this.drainDue();
    }, WebhookDeliveryService.POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  onApplicationShutdown() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async deliver(
    url: string,
    body: string,
    signature: string,
    sessionId: string,
  ): Promise<DeliveryHandle> {
    const record = await this.repo.insertPending(sessionId, url, body, signature);
    const ok = await this.runAttempt(record);
    return { deliveryId: record.id, deliveredOnFirstAttempt: ok };
  }

  async getStatus(deliveryId: string): Promise<DeliveryRecord | undefined> {
    return this.repo.findById(deliveryId);
  }

  async getStatusBySession(sessionId: string): Promise<DeliveryRecord | undefined> {
    return this.repo.findLatestBySession(sessionId);
  }

  async drainDue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const rows = await this.repo.claimDueDeliveries();
      // Attempts run *outside* the claim transaction — HTTP must never hold a row lock.
      for (const row of rows) {
        await this.runAttempt(row);
      }
    } catch (err) {
      this.logger.error(`drainDue failed: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  private async runAttempt(record: DeliveryRecord): Promise<boolean> {
    return withSpan(
      'webhook.deliver_attempt',
      {
        'delivery.id': record.id,
        'session.id': record.session_id,
        'delivery.attempt': record.attempts + 1,
      },
      async (span) => {
        const { success, lastError } = await this.executeHttpAttempt(record, span);
        const newAttempts = record.attempts + 1;

        webhookDeliveryAttemptsTotal.add(1, {
          outcome: success ? 'sent' : 'failed',
        });

        if (success) {
          await this.repo.markDelivered(record.id, newAttempts);
          webhookDeliveryFinalTotal.add(1, { outcome: 'delivered' });
          return true;
        }

        if (newAttempts >= WEBHOOK_DELIVERY.maxAttempts) {
          await this.repo.markFailed(record.id, newAttempts, lastError);
          webhookDeliveryFinalTotal.add(1, { outcome: 'failed' });
          this.logger.error(
            `Webhook delivery ${record.id} exhausted ${WEBHOOK_DELIVERY.maxAttempts} attempts; last error: ${lastError}`,
          );
          return false;
        }

        // attempt N (for N ≥ 2) fires `baseDelayMs * 2^(N-2)` after attempt N-1
        const delayMs = WEBHOOK_DELIVERY.baseDelayMs * Math.pow(2, newAttempts - 1);
        await this.repo.rescheduleAfter(record.id, newAttempts, delayMs, lastError);
        this.logger.warn(
          `Webhook delivery ${record.id} attempt ${newAttempts}/${WEBHOOK_DELIVERY.maxAttempts} → ${lastError}; retrying in ${delayMs}ms`,
        );
        return false;
      },
    );
  }

  private async executeHttpAttempt(
    record: DeliveryRecord,
    span: import('@opentelemetry/api').Span,
  ): Promise<{ success: boolean; lastError: string | null }> {
    try {
      const res = await fetchWithTimeout(record.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SIGNATURE_HEADER]: record.signature,
        },
        body: record.body,
      });
      span.setAttribute('http.status_code', res.status);
      return res.ok
        ? { success: true, lastError: null }
        : { success: false, lastError: `HTTP ${res.status}` };
    } catch (err) {
      return {
        success: false,
        lastError: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
