CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'PENDING_PAYMENT', 'CONFIRMED')),
  assigned_to_user_id UUID REFERENCES users(id),
  locked_at TIMESTAMPTZ
);

-- One active pending reservation per user at a time
CREATE UNIQUE INDEX IF NOT EXISTS seats_one_pending_per_user
  ON seats (assigned_to_user_id)
  WHERE status = 'PENDING_PAYMENT';

-- Sweep job: expire locks WHERE status = 'PENDING_PAYMENT' AND locked_at < threshold
CREATE INDEX IF NOT EXISTS seats_sweep_idx
  ON seats (status, locked_at)
  WHERE status = 'PENDING_PAYMENT';

-- Lookup by user (release / confirm flows)
CREATE INDEX IF NOT EXISTS seats_assigned_user_idx
  ON seats (assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;

INSERT INTO seats (id, status) VALUES ('A1', 'AVAILABLE'), ('A2', 'AVAILABLE'), ('A3', 'AVAILABLE')
ON CONFLICT DO NOTHING;
