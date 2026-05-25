import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  RESERVATION_LOCK_TTL_MINUTES,
  AUDIT_EVENT,
  AUDIT_OUTCOME,
} from '../common/constants';
import { PaymentAuditRepository } from '../audit/payment-audit.repository';
import { SeatExpiryRepository } from './seat-expiry.repository';
import { TransactionRunner } from '../database/transaction.runner';
import { withSpan } from '../observability/tracer';
import { seatExpirySweptTotal } from '../observability/metrics';

@Injectable()
export class SeatExpiryWorker {
  private readonly logger = new Logger(SeatExpiryWorker.name);

  constructor(
    private readonly repo: SeatExpiryRepository,
    private readonly audit: PaymentAuditRepository,
    private readonly tx: TransactionRunner,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireStaleReservations() {
    return withSpan('cron.seat_expiry_sweep', {}, () => this.runSweep());
  }

  /**
   * Arbitrary 64-bit key picked once for this worker; `pg_try_advisory_xact_lock`
   * serializes the sweep across every replica without registering anything in
   * a coordination table. Released automatically at COMMIT/ROLLBACK.
   */
  private static readonly SWEEP_ADVISORY_LOCK_KEY = 4242424242;

  /**
   * Run the sweep in one transaction so the reservation expiry, the seat
   * release, and the audit rows commit (or roll back) together — the ledger
   * can never disagree with the state it describes.
   *
   * Two replicas firing the cron at the same wall-clock minute would each
   * `UPDATE … WHERE status='PENDING_PAYMENT'` and one would lose the row to
   * the other's lock-then-update sequence — harmless for the seat itself, but
   * the loser's branch still tries to write its own audit row for a
   * reservation the winner already audited. The advisory lock makes the
   * loser short-circuit out of the sweep entirely.
   */
  private async runSweep(): Promise<void> {
    await this.tx.run(async (client) => {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1) AS locked',
        [SeatExpiryWorker.SWEEP_ADVISORY_LOCK_KEY],
      );
      if (!rows[0]?.locked) {
        this.logger.debug('Sweep skipped: another replica holds the advisory lock');
        return;
      }

      const expired = await this.repo.expireStaleReservations(client);
      if (expired.length === 0) return;

      await this.repo.releaseSeats(
        expired.map((r) => r.seat_id),
        client,
      );

      for (const row of expired) {
        await this.audit.record(
          {
            eventType: AUDIT_EVENT.RESERVATION_EXPIRED,
            outcome: AUDIT_OUTCOME.FAILED,
            reservationId: row.id,
            sessionId: row.session_id,
            seatId: row.seat_id,
            userId: row.user_id,
            rawPayload: {
              reason: 'lock TTL exceeded',
              ttlMinutes: RESERVATION_LOCK_TTL_MINUTES,
            },
          },
          client,
        );
      }
      this.logger.log(`Expired ${expired.length} stale reservation(s)`);
      seatExpirySweptTotal.add(expired.length);
    });
  }
}
