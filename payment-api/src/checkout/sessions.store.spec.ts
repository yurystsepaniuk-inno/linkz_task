import { NotFoundException } from '@nestjs/common';
import { SessionsStore } from './sessions.store';
import { SESSION_STATUS } from '../common/constants';

describe('SessionsStore', () => {
  let store: SessionsStore;

  beforeEach(() => {
    store = new SessionsStore();
    jest.useFakeTimers();
  });

  afterEach(() => jest.useRealTimers());

  it('creates a session with PENDING status', () => {
    const { sessionId } = store.create('A1', 'user-1', 10);
    const session = store.get(sessionId);
    expect(session?.status).toBe(SESSION_STATUS.PENDING);
  });

  it('returns undefined for an unknown session', () => {
    expect(store.get('sess_unknown')).toBeUndefined();
  });

  it('returns undefined and evicts after TTL expires', () => {
    const { sessionId } = store.create('A1', 'user-1', 10);
    expect(store.get(sessionId)).toBeDefined();
    jest.advanceTimersByTime(30 * 60 * 1000 + 1);
    expect(store.get(sessionId)).toBeUndefined();
  });

  it('returns session before TTL expires', () => {
    const { sessionId } = store.create('A1', 'user-1', 10);
    jest.advanceTimersByTime(30 * 60 * 1000 - 1);
    expect(store.get(sessionId)).toBeDefined();
  });

  it('update changes session status', () => {
    const { sessionId } = store.create('A1', 'user-1', 10);
    store.update(sessionId, SESSION_STATUS.PAID);
    expect(store.get(sessionId)?.status).toBe(SESSION_STATUS.PAID);
  });

  it('update throws 404 for unknown session', () => {
    expect(() => store.update('sess_unknown', SESSION_STATUS.PAID)).toThrow(NotFoundException);
  });
});
