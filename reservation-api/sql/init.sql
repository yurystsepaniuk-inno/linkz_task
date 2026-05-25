-- Identity is owned by Clerk; this service stores no user credentials and no
-- `users` table. `reservations.user_id` holds the Clerk user id (e.g. user_2ab…)
-- as opaque text — there is no local row to reference.
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'PENDING_PAYMENT', 'CONFIRMED'))
);

CREATE TABLE IF NOT EXISTS reservations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id    TEXT NOT NULL REFERENCES seats(id),
  user_id    TEXT NOT NULL,
  session_id TEXT,
  status     TEXT NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'FAILED', 'EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at  TIMESTAMPTZ
);

-- Drop old constraint that blocked a user from pending on multiple seats
DROP INDEX IF EXISTS reservations_one_pending_per_user;

-- Idempotent upgrade for a DB created before Clerk: user_id was a UUID FK to
-- the (now removed) users table. Convert it to opaque text for Clerk ids.
-- Guarded with information_schema so re-running on an already-text column
-- does not pointlessly rewrite the table on every boot.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'reservations' AND column_name = 'user_id') <> 'text' THEN
    ALTER TABLE reservations ALTER COLUMN user_id TYPE TEXT USING user_id::text;
  END IF;
END $$;

-- Sweep job: find stale PENDING_PAYMENT reservations
CREATE INDEX IF NOT EXISTS reservations_sweep_idx
  ON reservations (status, locked_at)
  WHERE status = 'PENDING_PAYMENT';

-- Lookup reservations by user
CREATE INDEX IF NOT EXISTS reservations_user_idx
  ON reservations (user_id);

-- Webhook matching by session_id. UNIQUE because each checkout session is
-- created for one reservation, so two reservations sharing a session_id would
-- make the webhook routing ambiguous. Partial (WHERE session_id IS NOT NULL)
-- so freshly inserted PENDING_PAYMENT rows (no session_id yet) do not block
-- each other.
DROP INDEX IF EXISTS reservations_session_idx;
CREATE UNIQUE INDEX IF NOT EXISTS reservations_session_idx
  ON reservations (session_id)
  WHERE session_id IS NOT NULL;

-- Defense in depth behind the SELECT ... FOR UPDATE application lock: at most
-- one non-terminal (PENDING_PAYMENT) reservation may exist per seat. Even if
-- the service-layer lock ever regressed, the database itself rejects a second
-- concurrent booking with a unique violation (SQLSTATE 23505) instead of
-- silently double-booking. Terminal rows (CONFIRMED/FAILED/EXPIRED) are not in
-- the index, so a seat can be re-reserved after a prior reservation settles.
CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_pending_per_seat
  ON reservations (seat_id)
  WHERE status = 'PENDING_PAYMENT';

-- Append-only payment audit ledger. Every payment-related event — checkout
-- session creation, every webhook (valid, signature-rejected, stale), and
-- every reservation expiry — appends exactly one immutable row here. This is
-- the *history*; `reservations.status` remains the *current* state. Rows are
-- never UPDATEd or DELETEd. `raw_payload` keeps the exact received body for
-- dispute resolution. `reservation_id` is nullable: a stale or unsigned
-- webhook matches no reservation.
CREATE TABLE IF NOT EXISTS payment_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  UUID REFERENCES reservations(id) ON DELETE SET NULL,
  session_id      TEXT,
  seat_id         TEXT,
  user_id         TEXT,
  amount          NUMERIC(10, 2),
  event_type      TEXT NOT NULL CHECK (event_type IN (
                    'CHECKOUT_SESSION_CREATED', 'WEBHOOK_RECEIVED', 'PAYMENT_SUCCEEDED',
                    'PAYMENT_FAILED', 'SIGNATURE_REJECTED', 'DUPLICATE_WEBHOOK',
                    'RESERVATION_EXPIRED', 'REFUND_INITIATED', 'REFUND_ATTEMPT_FAILED',
                    'REFUND_GAVE_UP', 'RECONCILIATION_DISMISSED')),
  outcome         TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILED', 'REJECTED', 'NOOP')),
  signature_valid BOOLEAN,
  raw_payload     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent upgrade: re-create the event_type CHECK constraint so older
-- databases (pre-REFUND_INITIATED) accept the new value. Postgres names
-- inline CHECKs `<table>_<column>_check` by default.
ALTER TABLE payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_event_type_check;
ALTER TABLE payment_transactions
  ADD CONSTRAINT payment_transactions_event_type_check
  CHECK (event_type IN (
    'CHECKOUT_SESSION_CREATED', 'WEBHOOK_RECEIVED', 'PAYMENT_SUCCEEDED',
    'PAYMENT_FAILED', 'SIGNATURE_REJECTED', 'DUPLICATE_WEBHOOK',
    'RESERVATION_EXPIRED', 'REFUND_INITIATED', 'REFUND_ATTEMPT_FAILED',
    'REFUND_GAVE_UP', 'RECONCILIATION_DISMISSED'));

-- Idempotent upgrade for databases created before this change: the original
-- FK was created without `ON DELETE SET NULL`. The ledger is the immutable
-- record of what happened; deleting a reservation must not cascade and erase
-- the audit row alongside it.
ALTER TABLE payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_reservation_id_fkey;
ALTER TABLE payment_transactions
  ADD CONSTRAINT payment_transactions_reservation_id_fkey
  FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL;

-- Reconciliation: pull the full event history for one reservation.
CREATE INDEX IF NOT EXISTS payment_transactions_reservation_idx
  ON payment_transactions (reservation_id);
-- Reconciliation: correlate events by payment-provider session id.
CREATE INDEX IF NOT EXISTS payment_transactions_session_idx
  ON payment_transactions (session_id)
  WHERE session_id IS NOT NULL;

-- At-most-one REFUND_INITIATED per session. The reconciliation cron is
-- horizontally scaled — two replicas can both pick up the same orphan in
-- the same tick (their `NOT EXISTS` candidate gate passes for both because
-- neither audit row has been written yet) and both proceed to call
-- `POST /api/refunds`. The refund itself is idempotent on session_id at the
-- payment-api side, so no double refund is issued — but each replica would
-- then write its own REFUND_INITIATED audit row, producing a duplicated
-- ledger. This partial unique index lets the audit-write use
-- `ON CONFLICT DO NOTHING` so concurrent writers collapse to exactly one
-- audit row per session. The predicate excludes NULL session_ids (which
-- never apply for refunds) and other event types (whose multiplicity is
-- intentional — e.g. one CHECKOUT_SESSION_CREATED + one PAYMENT_SUCCEEDED
-- per session is the normal happy path).
CREATE UNIQUE INDEX IF NOT EXISTS ux_refund_initiated_one_per_session
  ON payment_transactions (session_id)
  WHERE event_type = 'REFUND_INITIATED' AND session_id IS NOT NULL;

INSERT INTO seats (id, status) VALUES ('A1', 'AVAILABLE'), ('A2', 'AVAILABLE'), ('A3', 'AVAILABLE')
ON CONFLICT DO NOTHING;
