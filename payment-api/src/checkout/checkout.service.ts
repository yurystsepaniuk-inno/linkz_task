import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { SessionsRepository, CheckoutSession } from './sessions.repository';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { CreateSessionDto, PayDto } from './checkout.dto';
import {
  PAYMENT_EVENT,
  SESSION_STATUS,
  PAYMENT_RESULT,
  CARD_LAST4,
  PAYMENT_ERROR_CODE,
  PaymentEvent,
  PaymentResult,
  SessionStatus,
} from '../common/constants';
import { MESSAGES } from '../common/messages';
import { withSpan } from '../observability/tracer';
import {
  paymentAttemptsTotal,
  paymentRequestDuration,
  recordDuration,
} from '../observability/metrics';

export interface PayResponse {
  status: PaymentResult;
  /**
   * True when the webhook reached reservation-api on the synchronous first
   * attempt. False means delivery is being retried in the background.
   */
  webhookDelivered: boolean;
  deliveryId: string;
}

type PreOutcomeResult = 'invalid_card' | 'unknown_session' | 'already_processed';

interface PaymentLifecycle {
  result: PaymentResult;
  event: PaymentEvent;
  sessionStatus: SessionStatus;
}

interface SignedWebhook {
  url: string;
  body: string;
  signature: string;
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly sessions: SessionsRepository,
    private readonly config: ConfigService,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  async createSession(dto: CreateSessionDto) {
    // payment-api is the single source of truth for seat pricing: the caller
    // (reservation-api) sends only the seat + user, and the amount is resolved
    // here against `RESERVATION_AMOUNT`. The price is returned in the response
    // so the caller can write its own audit row without duplicating the env.
    const amount = parseFloat(this.config.getOrThrow<string>('RESERVATION_AMOUNT'));
    const { sessionId } = await this.sessions.create(dto.seatId, dto.userId, amount);
    const baseUrl = this.config.getOrThrow<string>('PUBLIC_BASE_URL');
    return {
      sessionId,
      checkoutUrl: `${baseUrl}/checkout/${sessionId}`,
      amount,
    };
  }

  async getSession(sessionId: string) {
    const session = await this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundException({
        message: MESSAGES.sessions.notFound,
        code: PAYMENT_ERROR_CODE.SESSION_NOT_FOUND,
      });
    }
    return { seatId: session.seatId, amount: session.amount };
  }

  /**
   * Existence-only probe — returns nothing on hit, throws 404 on miss.
   * Used by the unauthenticated delivery-status endpoint so a guessed-bad
   * session id gets a clean 404 without exposing the full session payload.
   */
  async assertSessionExists(sessionId: string): Promise<void> {
    const exists = await this.sessions.exists(sessionId);
    if (!exists) {
      throw new NotFoundException({
        message: MESSAGES.sessions.notFound,
        code: PAYMENT_ERROR_CODE.SESSION_NOT_FOUND,
      });
    }
  }

  /** Service-to-service read used by reservation-api's reconciliation cron. */
  async getSessionStatus(sessionId: string) {
    const session = await this.sessions.getInternal(sessionId);
    if (!session) {
      throw new NotFoundException({
        message: MESSAGES.sessions.notFound,
        code: PAYMENT_ERROR_CODE.SESSION_NOT_FOUND,
      });
    }
    return {
      sessionId,
      status: session.status,
      seatId: session.seatId,
      userId: session.userId,
      amount: session.amount,
    };
  }

  async pay(sessionId: string, dto: PayDto): Promise<PayResponse> {
    const started = process.hrtime.bigint();
    return withSpan('checkout.pay', { 'session.id': sessionId }, async (span) => {
      const lifecycle = this.validateCardOrThrow(dto.cardNumber, started);
      span.setAttribute('payment.result', lifecycle.result);

      const claimed = await this.claimSessionOrThrow(sessionId, lifecycle.sessionStatus, started);

      const signed = this.signPaymentWebhook(sessionId, claimed, lifecycle.event);
      const handle = await this.delivery.deliver(
        signed.url,
        signed.body,
        signed.signature,
        sessionId,
      );
      this.emitPaymentOutcome(started, lifecycle.result);
      span.setAttribute('webhook.delivered_first_attempt', handle.deliveredOnFirstAttempt);

      return {
        status: lifecycle.result,
        webhookDelivered: handle.deliveredOnFirstAttempt,
        deliveryId: handle.deliveryId,
      };
    });
  }

  // --- step helpers -------------------------------------------------------

  private validateCardOrThrow(cardNumber: string, started: bigint): PaymentLifecycle {
    const digits = cardNumber.replace(/\D/g, '');
    const last4 = digits.slice(-4);
    if (last4 !== CARD_LAST4.SUCCESS && last4 !== CARD_LAST4.FAILURE) {
      this.emitPreOutcomeError(started, 'invalid_card');
      throw new BadRequestException({
        message: MESSAGES.payment.invalidCardLast4,
        code: PAYMENT_ERROR_CODE.INVALID_CARD_FORMAT,
      });
    }
    const success = last4 === CARD_LAST4.SUCCESS;
    return {
      result: success ? PAYMENT_RESULT.SUCCESS : PAYMENT_RESULT.FAILED,
      event: success ? PAYMENT_EVENT.SUCCEEDED : PAYMENT_EVENT.FAILED,
      sessionStatus: success ? SESSION_STATUS.PAID : SESSION_STATUS.FAILED,
    };
  }

  private async claimSessionOrThrow(
    sessionId: string,
    finalStatus: SessionStatus,
    started: bigint,
  ): Promise<CheckoutSession> {
    const claimed = await this.sessions.tryClaim(sessionId, finalStatus);
    if (claimed) return claimed;

    const existing = await this.sessions.getInternal(sessionId);
    if (!existing) {
      this.emitPreOutcomeError(started, 'unknown_session');
      throw new NotFoundException({
        message: MESSAGES.sessions.notFound,
        code: PAYMENT_ERROR_CODE.SESSION_NOT_FOUND,
      });
    }
    this.emitPreOutcomeError(started, 'already_processed');
    throw new BadRequestException({
      message: MESSAGES.sessions.alreadyProcessed,
      code: PAYMENT_ERROR_CODE.SESSION_ALREADY_PROCESSED,
    });
  }

  private signPaymentWebhook(
    sessionId: string,
    claimed: CheckoutSession,
    event: PaymentEvent,
  ): SignedWebhook {
    const body = JSON.stringify({
      event,
      sessionId,
      seatId: claimed.seatId,
      userId: claimed.userId,
    });
    const secret = this.config.getOrThrow<string>('WEBHOOK_SECRET');
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const reservationApiUrl = this.config.getOrThrow<string>('RESERVATION_API_URL');
    return {
      url: `${reservationApiUrl}/api/webhooks/payment`,
      body,
      signature,
    };
  }

  private emitPreOutcomeError(started: bigint, result: PreOutcomeResult): void {
    paymentAttemptsTotal.add(1, { result });
    recordDuration(paymentRequestDuration, started);
  }

  private emitPaymentOutcome(started: bigint, result: PaymentResult): void {
    paymentAttemptsTotal.add(1, { result });
    recordDuration(paymentRequestDuration, started, { result });
  }
}
