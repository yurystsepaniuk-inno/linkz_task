-- payment-api owns its own Postgres database (`payments`, on its own container
-- and port). Tables live in `public` of that DB. There is no schema qualifier
-- — the database boundary IS the service boundary, so qualifying every query
-- with a schema name would be ceremonial. reservation-api literally cannot
-- read these tables, because they're on a different host.

-- Checkout sessions. The *primary* state payment-api holds — created when
-- reservation-api calls POST /api/checkout/sessions, claimed (PENDING → PAID
-- or FAILED) when the buyer submits a card, and read by the hosted checkout
-- page and by reservation-api's reconciliation cron.
--
-- The single-use guard that prevents replaying a settled session is an
-- atomic conditional UPDATE in `SessionsStore.tryClaim()` rather than a
-- read-then-write — safe even across multiple payment-api instances.
--
-- `id` is the full session identifier (e.g. `sess_<uuid>`) — the same string
-- referenced by `webhook_deliveries.session_id` and `refunds.session_id`.
-- Stored as TEXT (not UUID) because the application-level prefix is part of
-- the contract with reservation-api.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id          TEXT PRIMARY KEY,
  seat_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  amount      NUMERIC(10, 2) NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'EXPIRED')),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Re-affirm the status CHECK on an existing table (CREATE TABLE IF NOT EXISTS
-- silently skips the constraint on a pre-existing row). Keeps the EXPIRED
-- state migration safe to re-run without a `docker compose down -v` reset.
ALTER TABLE checkout_sessions DROP CONSTRAINT IF EXISTS checkout_sessions_status_check;
ALTER TABLE checkout_sessions ADD CONSTRAINT checkout_sessions_status_check
  CHECK (status IN ('PENDING', 'PAID', 'FAILED', 'EXPIRED'));

-- Drives the TTL sweep that transitions PENDING → EXPIRED once `expires_at`
-- has passed (see `CheckoutSessionExpirySweeper`). Partial on `status =
-- 'PENDING'` because once a session settles (PAID/FAILED/EXPIRED) it is no
-- longer eligible for the sweep and would only bloat the index.
CREATE INDEX IF NOT EXISTS checkout_sessions_expiry_idx
  ON checkout_sessions (expires_at)
  WHERE status = 'PENDING';

-- Outbox-style table for outbound webhook deliveries to reservation-api.
-- Previously an in-memory `Map`; persisting means retries survive a
-- payment-api restart, and ops can inspect stuck deliveries with SQL instead
-- of trawling log files.
--
-- Lifecycle:
--   PENDING   → the next attempt will run at `next_attempt_at`
--   DELIVERED → at least one attempt returned 2xx; we are done
--   FAILED    → exhausted `WEBHOOK_DELIVERY.maxAttempts`; reconciliation
--                cron (reservation-api side) becomes the recovery path
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL,
  url             TEXT NOT NULL,
  body            TEXT NOT NULL,    -- exact rawBody used for HMAC signing
  signature       TEXT NOT NULL,    -- HMAC-SHA256 hex digest
  status          TEXT NOT NULL CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,      -- NULL once terminal (DELIVERED/FAILED)
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The background worker polls for due retries with this index; covers the
-- common `WHERE status='PENDING' AND next_attempt_at <= NOW()` predicate.
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at)
  WHERE status = 'PENDING';

-- Correlation by upstream payment session id (for ops queries).
CREATE INDEX IF NOT EXISTS webhook_deliveries_session_idx
  ON webhook_deliveries (session_id);

-- Refunds: one row per refunded session. The UNIQUE constraint on
-- session_id is the idempotency key — a reconciliation cron that calls
-- POST /api/refunds twice for the same session gets the same row both
-- times, never a duplicate refund.
CREATE TABLE IF NOT EXISTS refunds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    TEXT NOT NULL UNIQUE,
  amount        NUMERIC(10, 2) NOT NULL,
  reason        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('REFUNDED', 'FAILED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
