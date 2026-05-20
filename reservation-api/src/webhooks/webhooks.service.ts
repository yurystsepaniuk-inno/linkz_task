import {
  Injectable,
  Inject,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { createHmac, timingSafeEqual } from 'crypto';
import { PG_POOL } from '../database/database.module';
import { PAYMENT_EVENT, SEAT_STATUS, RESERVATION_STATUS, PaymentEvent } from '../common/constants';
import { MESSAGES } from '../common/messages';

export interface WebhookPayload {
  event: PaymentEvent;
  sessionId: string;
  seatId: string;
  userId: string;
}

@Injectable()
export class WebhooksService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {}

  verifySignature(rawBody: Buffer, signature: string): void {
    const secret = this.config.getOrThrow<string>('WEBHOOK_SECRET');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new UnauthorizedException(MESSAGES.webhooks.invalidSignature);
    }
  }

  async handle(payload: WebhookPayload): Promise<{ received: boolean }> {
    switch (payload.event) {
      case PAYMENT_EVENT.SUCCEEDED:
        await this.pool.query(
          'UPDATE reservations SET status = $1 WHERE session_id = $2 AND status = $3',
          [RESERVATION_STATUS.CONFIRMED, payload.sessionId, RESERVATION_STATUS.PENDING_PAYMENT],
        );
        await this.pool.query(
          'UPDATE seats SET status = $1 WHERE id = $2 AND status = $3',
          [SEAT_STATUS.CONFIRMED, payload.seatId, SEAT_STATUS.PENDING_PAYMENT],
        );
        break;
      case PAYMENT_EVENT.FAILED:
        await this.pool.query(
          'UPDATE reservations SET status = $1 WHERE session_id = $2 AND status = $3',
          [RESERVATION_STATUS.FAILED, payload.sessionId, RESERVATION_STATUS.PENDING_PAYMENT],
        );
        await this.pool.query(
          'UPDATE seats SET status = $1 WHERE id = $2 AND status = $3',
          [SEAT_STATUS.AVAILABLE, payload.seatId, SEAT_STATUS.PENDING_PAYMENT],
        );
        break;
      default:
        throw new BadRequestException(MESSAGES.webhooks.unknownEvent);
    }
    return { received: true };
  }
}
