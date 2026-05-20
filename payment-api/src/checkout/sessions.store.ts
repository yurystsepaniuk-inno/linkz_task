import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SESSION_STATUS, SESSION_ID_PREFIX, SessionStatus } from '../common/constants';
import { MESSAGES } from '../common/messages';

export interface CheckoutSession {
  seatId: string;
  userId: string;
  amount: number;
  status: SessionStatus;
}

@Injectable()
export class SessionsStore {
  private readonly sessions = new Map<string, CheckoutSession>();

  create(seatId: string, userId: string, amount: number): { sessionId: string } {
    const sessionId = `${SESSION_ID_PREFIX}${randomUUID()}`;
    this.sessions.set(sessionId, { seatId, userId, amount, status: SESSION_STATUS.PENDING });
    return { sessionId };
  }

  get(sessionId: string): CheckoutSession | undefined {
    return this.sessions.get(sessionId);
  }

  update(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new NotFoundException(MESSAGES.sessions.notFound);
    session.status = status;
  }
}
