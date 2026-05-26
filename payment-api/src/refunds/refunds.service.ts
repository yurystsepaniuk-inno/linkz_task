import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { SessionsRepository } from '../checkout/sessions.repository';
import { RefundsRepository, RefundRow } from './refunds.repository';
import { SESSION_STATUS, REFUND_STATUS } from '../common/constants';
import { CreateRefundDto } from './refund.dto';
import { withSpan } from '../observability/tracer';
import { refundRequestsTotal } from '../observability/metrics';

export { RefundRow };

/**
 * Idempotent on `session_id` (UNIQUE constraint). Called by reservation-api's
 * reconciliation cron when a PAID session has no CONFIRMED reservation.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly refunds: RefundsRepository,
    private readonly sessions: SessionsRepository,
  ) {}

  async create(dto: CreateRefundDto): Promise<RefundRow> {
    return withSpan('refund.create', { 'session.id': dto.sessionId }, async (span) => {
      // Fast path for the cron's retries — return the prior row instead of
      // racing the UNIQUE(session_id) constraint.
      const existing = await this.refunds.findBySession(dto.sessionId);
      if (existing) {
        refundRequestsTotal.add(1, { outcome: 'duplicate_noop' });
        span.setAttribute('refund.outcome', 'duplicate_noop');
        return existing;
      }

      const session = await this.sessions.getInternal(dto.sessionId);
      if (!session) {
        refundRequestsTotal.add(1, { outcome: 'unknown_session' });
        throw new NotFoundException(`Unknown session: ${dto.sessionId}`);
      }
      if (session.status !== SESSION_STATUS.PAID) {
        // Refusing FAILED/PENDING is what stops a misfiring reconciliation
        // from "refunding" a payment that never happened.
        refundRequestsTotal.add(1, { outcome: 'invalid_status' });
        throw new BadRequestException(
          `Cannot refund a ${session.status} session (only PAID is refundable)`,
        );
      }

      const row = await this.refunds.upsert(
        dto.sessionId,
        session.amount,
        dto.reason ?? null,
        REFUND_STATUS.REFUNDED,
      );
      refundRequestsTotal.add(1, { outcome: 'refunded' });
      span.setAttribute('refund.outcome', 'refunded');
      this.logger.log(`Refund issued for session ${dto.sessionId} (amount ${session.amount})`);
      return row;
    });
  }

  async findBySession(sessionId: string): Promise<RefundRow | undefined> {
    return this.refunds.findBySession(sessionId);
  }
}
