CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'PENDING_PAYMENT', 'CONFIRMED'))
);

CREATE TABLE IF NOT EXISTS reservations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id    TEXT NOT NULL REFERENCES seats(id),
  user_id    UUID NOT NULL REFERENCES users(id),
  session_id TEXT,
  status     TEXT NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'FAILED', 'EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at  TIMESTAMPTZ
);

-- Drop old constraint that blocked a user from pending on multiple seats
DROP INDEX IF EXISTS reservations_one_pending_per_user;

-- Sweep job: find stale PENDING_PAYMENT reservations
CREATE INDEX IF NOT EXISTS reservations_sweep_idx
  ON reservations (status, locked_at)
  WHERE status = 'PENDING_PAYMENT';

-- Lookup reservations by user
CREATE INDEX IF NOT EXISTS reservations_user_idx
  ON reservations (user_id);

-- Webhook matching by session_id
CREATE INDEX IF NOT EXISTS reservations_session_idx
  ON reservations (session_id)
  WHERE session_id IS NOT NULL;

INSERT INTO seats (id, status) VALUES ('A1', 'AVAILABLE'), ('A2', 'AVAILABLE'), ('A3', 'AVAILABLE')
ON CONFLICT DO NOTHING;
