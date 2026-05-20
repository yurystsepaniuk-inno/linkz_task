import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SESSION_STATUS, SESSION_ID_PREFIX, SessionStatus } from '../common/constants';
import { MESSAGES } from '../common/messages';

const SESSION_TTL_MS = 30 * 60 * 1000;

export interface CheckoutSession {
  seatId: string;
  userId: string;
  amount: number;
  status: SessionStatus;
  expiresAt: number;
}

@Injectable()
export class SessionsStore {
  private readonly sessions = new Map<string, CheckoutSession>();

  create(seatId: string, userId: string, amount: number): { sessionId: string } {
    const sessionId = `${SESSION_ID_PREFIX}${randomUUID()}`;
    this.sessions.set(sessionId, {
      seatId,
      userId,
      amount,
      status: SESSION_STATUS.PENDING,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return { sessionId };
  }

  get(sessionId: string): CheckoutSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  update(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new NotFoundException(MESSAGES.sessions.notFound);
    session.status = status;
  }
}
