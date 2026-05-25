import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Span } from '@opentelemetry/api';
import {
  PAYMENT_EVENT,
  SEAT_STATUS,
  RESERVATION_STATUS,
  AUDIT_EVENT,
  AUDIT_OUTCOME,
  PaymentEvent,
  ReservationStatus,
  SeatStatus,
  AuditEvent,
  AuditOutcome,
} from '../common/constants';
import { MESSAGES } from '../common/messages';
import { PaymentAuditRepository } from '../audit/payment-audit.repository';
import { WebhooksRepository, MatchedReservation } from './webhooks.repository';
import { TransactionRunner } from '../database/transaction.runner';
import { withSpan } from '../observability/tracer';
import {
  paymentOutcomesTotal,
  webhookSignatureRejectedTotal,
} from '../observability/metrics';

export interface WebhookPayload {
  event: PaymentEvent;
  sessionId: string;
  seatId: string;
  userId: string;
}

interface EventMapping {
  reservationStatus: ReservationStatus;
  seatStatus: SeatStatus;
  outcomeEvent: AuditEvent;
}

type WebhookTxnResult =
  | { kind: 'duplicate' }
  | { kind: 'applied'; matchedLiveReservation: boolean };

@Injectable()
export class WebhooksService {
  constructor(
    private readonly repo: WebhooksRepository,
    private readonly audit: PaymentAuditRepository,
    private readonly tx: TransactionRunner,
    private readonly config: ConfigService,
  ) {}

  /** True when `signature` is a valid HMAC of `rawBody`; never throws. */
  isSignatureValid(rawBody: Buffer | undefined, signature: string): boolean {
    if (!rawBody) return false;
    const secret = this.config.getOrThrow<string>('WEBHOOK_SECRET');
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
  }

  async handle(
    payload: WebhookPayload,
    rawBody: Buffer | undefined,
    signature: string,
  ): Promise<{ received: boolean }> {
    return withSpan(
      'webhook.handle',
      {
        'webhook.event': payload?.event ?? 'unknown',
        'session.id': payload?.sessionId ?? 'unknown',
      },
      async (span) => this.handleInternal(payload, rawBody, signature, span),
    );
  }

  private async handleInternal(
    payload: WebhookPayload,
    rawBody: Buffer | undefined,
    signature: string,
    span: Span,
  ): Promise<{ received: boolean }> {
    await this.rejectInvalidSignatureOrThrow(payload, rawBody, signature, span);
    const mapping = this.mapEventToStatuses(payload.event);
    const result = await this.applyWebhookTransaction(payload, mapping, span);
    this.emitPostCommitMetric(payload, result, span);
    return { received: true };
  }

  // --- step helpers -------------------------------------------------------

  /** Tampering attempts go in the ledger as SIGNATURE_REJECTED so they're
   *  queryable post-hoc — a 401 alone leaves no trace. */
  private async rejectInvalidSignatureOrThrow(
    payload: WebhookPayload,
    rawBody: Buffer | undefined,
    signature: string,
    span: Span,
  ): Promise<void> {
    if (this.isSignatureValid(rawBody, signature)) return;

    // Alert when > 0: every increment means someone is sending forged payloads.
    webhookSignatureRejectedTotal.add(1);
    span.addEvent('signature.rejected');
    await this.audit.record({
      eventType: AUDIT_EVENT.SIGNATURE_REJECTED,
      outcome: AUDIT_OUTCOME.REJECTED,
      sessionId: payload?.sessionId ?? null,
      seatId: payload?.seatId ?? null,
      userId: payload?.userId ?? null,
      signatureValid: false,
      rawPayload: payload,
    });
    throw new UnauthorizedException(MESSAGES.webhooks.invalidSignature);
  }

  private mapEventToStatuses(event: PaymentEvent): EventMapping {
    switch (event) {
      case PAYMENT_EVENT.SUCCEEDED:
        return {
          reservationStatus: RESERVATION_STATUS.CONFIRMED,
          seatStatus: SEAT_STATUS.CONFIRMED,
          outcomeEvent: AUDIT_EVENT.PAYMENT_SUCCEEDED,
        };
      case PAYMENT_EVENT.FAILED:
        return {
          reservationStatus: RESERVATION_STATUS.FAILED,
          seatStatus: SEAT_STATUS.AVAILABLE,
          outcomeEvent: AUDIT_EVENT.PAYMENT_FAILED,
        };
      default:
        throw new BadRequestException(MESSAGES.webhooks.unknownEvent);
    }
  }

  /** Audit rows and state updates commit together; on duplicate
   *  (same session_id + outcome event already in the ledger) we short-circuit
   *  with a DUPLICATE_WEBHOOK row instead of touching state again. */
  private async applyWebhookTransaction(
    payload: WebhookPayload,
    mapping: EventMapping,
    span: Span,
  ): Promise<WebhookTxnResult> {
    return this.tx.run(async (client) => {
      await this.audit.record(
        {
          eventType: AUDIT_EVENT.WEBHOOK_RECEIVED,
          outcome: AUDIT_OUTCOME.SUCCESS,
          sessionId: payload.sessionId,
          seatId: payload.seatId,
          userId: payload.userId,
          signatureValid: true,
          rawPayload: payload,
        },
        client,
      );

      if (await this.audit.hasPriorOutcome(payload.sessionId, mapping.outcomeEvent, client)) {
        await this.audit.record(
          {
            eventType: AUDIT_EVENT.DUPLICATE_WEBHOOK,
            outcome: AUDIT_OUTCOME.NOOP,
            sessionId: payload.sessionId,
            seatId: payload.seatId,
            userId: payload.userId,
            signatureValid: true,
            rawPayload: payload,
          },
          client,
        );
        span.addEvent('webhook.duplicate');
        return { kind: 'duplicate' };
      }

      const matched = await this.transitionReservationAndSeat(payload, mapping, client);

      await this.audit.record(
        {
          eventType: mapping.outcomeEvent,
          outcome: this.outcomeFor(matched, payload.event),
          reservationId: matched?.id ?? null,
          sessionId: payload.sessionId,
          seatId: matched?.seat_id ?? null,
          userId: payload.userId,
          signatureValid: true,
          rawPayload: payload,
        },
        client,
      );

      return { kind: 'applied', matchedLiveReservation: !!matched };
    });
  }

  /** seat_id comes from the *matched* reservation, never from the payload —
   *  a stale event matches no row, so a seat now owned by another user is
   *  left alone. */
  private async transitionReservationAndSeat(
    payload: WebhookPayload,
    mapping: EventMapping,
    client: import('pg').PoolClient,
  ): Promise<MatchedReservation | undefined> {
    const matched = await this.repo.transitionReservation(
      payload.sessionId,
      mapping.reservationStatus,
      client,
    );
    if (matched) {
      await this.repo.setSeatStatusIfPending(matched.seat_id, mapping.seatStatus, client);
    }
    return matched;
  }

  private outcomeFor(
    matched: MatchedReservation | undefined,
    event: PaymentEvent,
  ): AuditOutcome {
    if (!matched) return AUDIT_OUTCOME.NOOP;
    return event === PAYMENT_EVENT.SUCCEEDED
      ? AUDIT_OUTCOME.SUCCESS
      : AUDIT_OUTCOME.FAILED;
  }

  /** Post-COMMIT only — emits outcomes that actually persisted.
   *  `duplicate` and `noop` get their own buckets so payment-api over-retries
   *  and stale-webhook bursts don't look like real activity. */
  private emitPostCommitMetric(
    payload: WebhookPayload,
    result: WebhookTxnResult,
    span: Span,
  ): void {
    if (result.kind === 'duplicate') {
      paymentOutcomesTotal.add(1, { outcome: 'duplicate' });
      return;
    }
    const counterOutcome = result.matchedLiveReservation
      ? payload.event === PAYMENT_EVENT.SUCCEEDED
        ? 'succeeded'
        : 'failed'
      : 'noop';
    paymentOutcomesTotal.add(1, { outcome: counterOutcome });
    span.setAttribute('webhook.outcome', counterOutcome);
  }
}
