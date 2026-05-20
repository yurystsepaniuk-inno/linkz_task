import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { SessionsStore } from './sessions.store';
import { CreateSessionDto, PayDto } from './checkout.dto';
import {
  PAYMENT_EVENT,
  SESSION_STATUS,
  PAYMENT_RESULT,
  CARD_LAST4,
  SIGNATURE_HEADER,
  PaymentResult,
} from '../common/constants';
import { MESSAGES } from '../common/messages';

@Injectable()
export class CheckoutService {
  constructor(
    private readonly store: SessionsStore,
    private readonly config: ConfigService,
  ) {}

  createSession(dto: CreateSessionDto) {
    const { sessionId } = this.store.create(dto.seatId, dto.userId, dto.amount);
    const baseUrl = this.config.getOrThrow<string>('PUBLIC_BASE_URL');
    return {
      sessionId,
      checkoutUrl: `${baseUrl}/checkout/${sessionId}`,
    };
  }

  getSession(sessionId: string) {
    const session = this.store.get(sessionId);
    if (!session) throw new NotFoundException(MESSAGES.sessions.notFound);
    return { seatId: session.seatId, amount: session.amount };
  }

  async pay(sessionId: string, dto: PayDto): Promise<{ status: PaymentResult }> {
    const session = this.store.get(sessionId);
    if (!session) throw new NotFoundException(MESSAGES.sessions.notFound);

    const digits = dto.cardNumber.replace(/\D/g, '');
    const last4 = digits.slice(-4);

    if (last4 !== CARD_LAST4.SUCCESS && last4 !== CARD_LAST4.FAILURE) {
      throw new BadRequestException(MESSAGES.payment.invalidCardLast4);
    }

    const success = last4 === CARD_LAST4.SUCCESS;
    const event = success ? PAYMENT_EVENT.SUCCEEDED : PAYMENT_EVENT.FAILED;
    const sessionStatus = success ? SESSION_STATUS.PAID : SESSION_STATUS.FAILED;
    const result: PaymentResult = success ? PAYMENT_RESULT.SUCCESS : PAYMENT_RESULT.FAILED;

    this.store.update(sessionId, sessionStatus);

    const body = { event, seatId: session.seatId, userId: session.userId };
    const rawBody = JSON.stringify(body);
    const secret = this.config.getOrThrow<string>('WEBHOOK_SECRET');
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');

    const reservationApiUrl = this.config.getOrThrow<string>('RESERVATION_API_URL');
    await fetch(`${reservationApiUrl}/api/webhooks/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SIGNATURE_HEADER]: signature,
      },
      body: rawBody,
    }).catch((err) => {
      console.error('Webhook delivery failed:', err);
    });

    return { status: result };
  }
}
