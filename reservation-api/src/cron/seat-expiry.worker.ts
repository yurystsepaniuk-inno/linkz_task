import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { SEAT_STATUS, RESERVATION_LOCK_TTL_MINUTES } from '../common/constants';

@Injectable()
export class SeatExpiryWorker {
  private readonly logger = new Logger(SeatExpiryWorker.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireStaleReservations() {
    const result = await this.pool.query(
      `UPDATE seats SET status = $1, assigned_to_user_id = NULL, session_id = NULL, locked_at = NULL
       WHERE status = $2 AND locked_at < NOW() - ($3 || ' minutes')::interval`,
      [SEAT_STATUS.AVAILABLE, SEAT_STATUS.PENDING_PAYMENT, RESERVATION_LOCK_TTL_MINUTES],
    );
    if (result.rowCount && result.rowCount > 0) {
      this.logger.log(`Expired ${result.rowCount} stale reservation(s)`);
    }
  }
}
