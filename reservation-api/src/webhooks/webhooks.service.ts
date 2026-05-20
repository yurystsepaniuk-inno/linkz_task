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
import { PAYMENT_EVENT, SEAT_STATUS, PaymentEvent } from '../common/constants';
import { MESSAGES } from '../common/messages';

export interface WebhookPayload {
  event: PaymentEvent;
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
          'UPDATE seats SET status = $1, locked_at = NULL WHERE id = $2 AND status = $3 AND assigned_to_user_id = $4',
          [SEAT_STATUS.CONFIRMED, payload.seatId, SEAT_STATUS.PENDING_PAYMENT, payload.userId],
        );
        break;
      case PAYMENT_EVENT.FAILED:
        await this.pool.query(
          'UPDATE seats SET status = $1, assigned_to_user_id = NULL, locked_at = NULL WHERE id = $2 AND status = $3 AND assigned_to_user_id = $4',
          [SEAT_STATUS.AVAILABLE, payload.seatId, SEAT_STATUS.PENDING_PAYMENT, payload.userId],
        );
        break;
      default:
        throw new BadRequestException(MESSAGES.webhooks.unknownEvent);
    }
    return { received: true };
  }
}
