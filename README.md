# Seat Reservation Platform

A minimal seat reservation platform consisting of four services. The scope is deliberately small (3 seats) so the README can focus on the *engineering decisions* — what was built, what was deferred, and why.

Authentication is delegated to [Clerk](https://clerk.com): this platform stores no passwords and runs no identity database. See [Architecture Decisions](#architecture-decisions) for why, and how the long-lived-session requirement is met with short-lived access tokens.


The Gherkin acceptance criteria can be found in [docs/acceptance-criteria/](docs/acceptance-criteria/). Scenarios that were explicitly excluded from this implementation (such as full idempotency-key handling and DLQ routing) are detailed in [docs/scope-not-implemented/](docs/scope-not-implemented/). While these robust features are highly valuable for a production system, they fell outside what was realistic to implement within the original 2-hour time constraint of this assignment.

> **Update.** A follow-up iteration added the reconciliation/refund compensation loop that was originally documented as "out of scope" — see [Reconciliation & Refund Compensation](#reconciliation--refund-compensation). payment-api now owns its **own Postgres database** (`payments`, in its own container on port `5433`) with a persistent webhook-delivery outbox and a refunds table; reservation-api runs a reconciliation cron that detects orphaned PAID sessions and asks payment-api for an idempotent refund. The "known reconciliation gap" section at the bottom of this README is preserved as the *before* picture; the implemented solution is described inline.

## Contents


1. [Quick Start](#quick-start)
2. [End-to-End Flow](#end-to-end-flow)
3. [API Reference](#api-reference)
4. [Database Schema](#database-schema)
5. [Environment Variables](#environment-variables)
6. [Running Tests](#running-tests)
7. [Architecture Decisions](#architecture-decisions)
   - [Reconciliation & Refund Compensation](#reconciliation--refund-compensation)
8. [Deployment](#deployment)
9. [Security Considerations](#security-considerations)
10. [Failure Modes & Reliability](#failure-modes--reliability)


## Quick Start

### Prerequisites
- Node 20+
- Docker & Docker Compose

### 0. (Optional) Reset to a clean slate

Skip on a first run. If you've started this project before, wipe Docker volumes and `node_modules` so the steps below run against an empty database:

```bash
# `--profile observability` so the observability containers come into scope;
# `-v` so the named volumes (DBs, Grafana, Prometheus, Tempo, Loki) go too.
docker compose --profile observability down -v --remove-orphans

# Belt-and-braces: drop any volumes that survived a prior compose file.
docker volume rm -f \
  linkz_task_reservations_data linkz_task_payments_data \
  linkz_task_prometheus_data   linkz_task_tempo_data \
  linkz_task_loki_data         linkz_task_grafana_data 2>/dev/null || true

rm -rf reservation-api/node_modules payment-api/node_modules \
       reservation-web/node_modules payment-web/node_modules
rm -f reservation-api/.env payment-api/.env reservation-web/.env payment-web/.env
```

### 1. Start Postgres

```bash
# Without the observability stack
docker compose up -d

# With the observability stack (heavier; ~6 containers)
docker compose --profile observability up -d
```

### 2. Clerk keys (authentication)

Create a [Clerk](https://clerk.com) application and copy its publishable + secret keys into the `.env` files (see [Environment Variables](#environment-variables) for the variable names).

**Use Clerk Pro / paid production keys for the 90-day session requirement.** In the Clerk Dashboard, configure **Sessions → Maximum lifetime** to **90 days**. The long-lived session is still a revocable Clerk-managed cookie; the backend access token remains a short-lived JWT refreshed by Clerk, so this does not introduce a 90-day bearer token. A development/test Clerk instance can be used to run the demo locally, but production compliance for this requirement assumes a paid Clerk project with the 90-day maximum lifetime configured.

### 3. Configure environment

Copy each `.env.example` to `.env`:

```bash
cp reservation-api/.env.example reservation-api/.env
cp payment-api/.env.example     payment-api/.env
cp reservation-web/.env.example reservation-web/.env
cp payment-web/.env.example     payment-web/.env
```

Fill in the Clerk keys from step 2 in both `reservation-api/.env` (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`) and `reservation-web/.env` (`VITE_CLERK_PUBLISHABLE_KEY`).

> `WEBHOOK_SECRET` must be **identical** in `reservation-api/.env` and `payment-api/.env`.
> `PAYMENT_API_KEY` (reservation-api) must equal `API_KEY` (payment-api).

### 4. Migrate

Each API owns its **own Postgres database** running in its own container: reservation-api talks to the `reservations` database on port `5432`, payment-api talks to the `payments` database on port `5433`. Both databases come up with `docker compose up -d`, and each service has its own `migrate` script that creates its own tables.

```bash
cd reservation-api && npm install && npm run migrate && cd ..
cd payment-api     && npm install && npm run migrate && cd ..
```

`reservation-api/sql/init.sql` creates `seats`, `reservations`, and `payment_transactions` in the `reservations` DB; `payment-api/sql/init.sql` creates `checkout_sessions`, `webhook_deliveries`, and `refunds` in the `payments` DB. The reservation migration also seeds three seats (`A1`, `A2`, `A3`). There are no demo users — sign up through the web UI, which is handled entirely by Clerk.

### 5. Start all services

In four terminals:

```bash
# reservation-api (:3000)
cd reservation-api && npm run start:dev
```

```bash
# payment-api (:3003)
cd payment-api && npm install && npm run start:dev
```

```bash
# reservation-web (:3001)
cd reservation-web && npm install && npm run dev
```

```bash
# payment-web (:3002)
cd payment-web && npm install && npm run dev
```

---

## End-to-End Flow

1. Open <a href="http://localhost:3001" target="_blank">http://localhost:3001</a>
2. **Sign up** (or sign in) via the Clerk modal
3. Click an available (green) seat → click **Book**
4. You're redirected to `http://localhost:3002/checkout/sess_...`
5. Enter a card number ending in:
   - **`4000`** → payment succeeds, seat becomes `CONFIRMED`
   - **`5000`** → payment fails, seat reverts to `AVAILABLE`
   - anything else → 400 Bad Request
6. Click **Back To Seat Reservation** — seat status reflects the outcome.

---

## API Reference

### reservation-api (`:3000`)

Authentication is handled by Clerk; there is no login endpoint. Protected routes expect a Clerk session token as `Authorization: Bearer <token>`.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `GET`  | `/api/seats` | Clerk | — | `[{id, status}]` |
| `POST` | `/api/reservations` | Clerk | `{seatId}` | `201 {checkoutUrl}` / `409 SEAT_ALREADY_OCCUPIED` / `502` |
| `GET`  | `/api/reservations/:id/audit` | Clerk | — | `200 [{event_type, outcome, …}]` / `404` (not found / not yours) |
| `POST` | `/api/webhooks/payment` | HMAC `x-signature` | `{event, sessionId, seatId, userId}` | `{received:true}` / `401` / `400` |

### payment-api (`:3003`)

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `POST` | `/api/checkout/sessions` | `x-api-key` | `{seatId, userId}` | `{sessionId, checkoutUrl, amount}` / `401`. **No `amount` in the request body** — payment-api is the sole source of truth for seat pricing (`RESERVATION_AMOUNT`); the resolved value is echoed in the response so the caller can write its audit row from it. |
| `GET`  | `/api/checkout/sessions/:id` | — | — | `{seatId, amount}` / `404` |
| `GET`  | `/api/checkout/sessions/:id/status` | `x-api-key` | — | `{sessionId, status, seatId, userId, amount}` / `404` — service-to-service status lookup used by reservation-api's reconciliation cron |
| `GET`  | `/api/checkout/sessions/:id/delivery-status` | — (per-IP rate-limited: 120 req/min) | — | `{status, attempts, nextAttemptAt, terminalDelivered}` / `404`. Buyer-facing poll target so `payment-web`'s ResultPage can clear the "still syncing" banner when reservation-api has actually received the event. Safe without an API key — session ids are unguessable UUIDs the buyer already holds; abuse is bounded by the per-IP cap. |
| `POST` | `/api/checkout/sessions/:id/pay` | — | `{cardNumber}` | `{status, webhookDelivered, deliveryId}` / `400` (bad card / already processed) / `404` (session expired) |
| `POST` | `/api/refunds` | `x-api-key` | `{sessionId, reason?}` | `{id, session_id, amount, status: 'REFUNDED'}` / `400` (not PAID) / `404` (unknown session). Idempotent — calling twice for the same session returns the existing row |
| `GET`  | `/api/refunds/:sessionId` | `x-api-key` | — | `{...refund}` / `404` |

`webhookDelivered` is `true` when the reservation-api webhook was acknowledged on the synchronous first attempt; `false` means the payment-api is retrying in the background (up to 5 attempts, exponential backoff over ~15s). The frontend forwards this as `?delivered=0|1` so the result page can tell the user their seat is "still being confirmed" instead of pretending the flow is final.

---

## Database Schema

The platform runs **two Postgres containers**, one per microservice — strict database-per-service. Each service owns its own pool pointing at its own host:port:database, its own migration script, and its own tables. The two services cannot query each other's tables even if they tried; everything cross-service flows through HTTP. In production each database would move to its own RDS instance; the application code does not change, only the connection string.

```
reservations-db (container, :5432)        payments-db (container, :5433)
└── reservations DB                       └── payments DB
    ├── seats                                 ├── checkout_sessions   (PENDING → PAID/FAILED/EXPIRED;
    ├── reservations                          │                        atomic single-use claim + TTL sweep)
    └── payment_transactions                  ├── webhook_deliveries  (sender-side outbox;
        (append-only audit ledger)            │                        survives restarts)
                                              └── refunds             (idempotent on session_id)
        owned by reservation-api                  owned by payment-api
```

There is no `users` table in either database — identity is owned by Clerk, and `reservations.user_id` stores the Clerk user id (e.g. `user_2ab…`) as opaque text.

### `reservations` DB — reservation-api

```
seats
├── id     TEXT  PK
└── status TEXT  NOT NULL  CHECK (AVAILABLE | PENDING_PAYMENT | CONFIRMED)

reservations
├── id         UUID        PK
├── seat_id    TEXT        FK → seats.id   NOT NULL
├── user_id    TEXT        NOT NULL  (Clerk user id; no local FK)
├── session_id TEXT        (payment-provider session; set after checkout session is created)
├── status     TEXT        NOT NULL  CHECK (PENDING_PAYMENT | CONFIRMED | FAILED | EXPIRED)
├── created_at TIMESTAMPTZ NOT NULL  DEFAULT NOW()
└── locked_at  TIMESTAMPTZ (set at reservation time; swept by cron after 5 min)

payment_transactions   (append-only audit ledger — INSERT only, never UPDATE/DELETE)
├── id              UUID         PK
├── reservation_id  UUID         FK → reservations.id  (NULL for unmatched/unsigned webhooks)
├── session_id      TEXT
├── seat_id         TEXT
├── user_id         TEXT
├── amount          NUMERIC(10,2)
├── event_type      TEXT  NOT NULL  CHECK (CHECKOUT_SESSION_CREATED | WEBHOOK_RECEIVED |
│                                          PAYMENT_SUCCEEDED | PAYMENT_FAILED |
│                                          SIGNATURE_REJECTED | DUPLICATE_WEBHOOK |
│                                          RESERVATION_EXPIRED | REFUND_INITIATED)
├── outcome         TEXT  NOT NULL  CHECK (SUCCESS | FAILED | REJECTED | NOOP)
├── signature_valid BOOLEAN
├── raw_payload     JSONB        (exact received body, for dispute resolution)
└── created_at      TIMESTAMPTZ NOT NULL  DEFAULT NOW()
```

**Indexes on `reservations`:**

| Index | Columns | Purpose |
|---|---|---|
| `reservations_sweep_idx` | `(status, locked_at)` WHERE `PENDING_PAYMENT` | cron expiry sweep |
| `reservations_user_idx` | `user_id` | lookup by user |
| `reservations_session_idx` | `session_id` WHERE NOT NULL | webhook matching |
| `reservations_one_pending_per_seat` | `seat_id` WHERE `PENDING_PAYMENT` (**UNIQUE**) | DB-level double-booking guard |

**Indexes on `payment_transactions`:**

| Index | Columns | Purpose |
|---|---|---|
| `payment_transactions_reservation_idx` | `reservation_id` | full history for one reservation |
| `payment_transactions_session_idx` | `session_id` WHERE NOT NULL | correlate events by payment session |

### `payments` DB — payment-api

```
checkout_sessions    (the primary state payment-api holds — survives restarts)
├── id         TEXT         PK    (e.g. `sess_<uuid>` — the same string referenced from
│                                  webhook_deliveries.session_id and refunds.session_id)
├── seat_id    TEXT         NOT NULL
├── user_id    TEXT         NOT NULL  (Clerk user id; opaque text)
├── amount     NUMERIC(10,2) NOT NULL
├── status     TEXT         NOT NULL  CHECK (PENDING | PAID | FAILED | EXPIRED)
├── expires_at TIMESTAMPTZ  NOT NULL  (30 min after creation; reads filter `> NOW()`)
├── created_at TIMESTAMPTZ  NOT NULL  DEFAULT NOW()
└── updated_at TIMESTAMPTZ  NOT NULL  DEFAULT NOW()

webhook_deliveries   (sender-side retry outbox — picked up by a background poller)
├── id              UUID         PK   DEFAULT gen_random_uuid()
├── session_id      TEXT         NOT NULL
├── url             TEXT         NOT NULL
├── body            TEXT         NOT NULL  (the exact JSON body that will be signed and POSTed)
├── signature       TEXT         NOT NULL  (HMAC-SHA256 of body, hex)
├── status          TEXT         NOT NULL  CHECK (PENDING | DELIVERED | FAILED)
├── attempts        INT          NOT NULL  DEFAULT 0
├── next_attempt_at TIMESTAMPTZ            (when the poller should try again; NULL once terminal)
├── last_error      TEXT                   (HTTP status or thrown message of the last attempt)
├── created_at      TIMESTAMPTZ  NOT NULL  DEFAULT NOW()
└── updated_at      TIMESTAMPTZ  NOT NULL  DEFAULT NOW()

refunds              (one row per refunded session; UNIQUE makes the API idempotent)
├── id          UUID          PK  DEFAULT gen_random_uuid()
├── session_id  TEXT          UNIQUE NOT NULL
├── amount      NUMERIC(10,2) NOT NULL
├── reason      TEXT
├── status      TEXT          NOT NULL  CHECK (REFUNDED | FAILED)
└── created_at  TIMESTAMPTZ   NOT NULL  DEFAULT NOW()
```

**Indexes on `checkout_sessions`:**

| Index | Columns | Purpose |
|---|---|---|
| `checkout_sessions_expiry_idx` | `expires_at` WHERE `PENDING` | drives the `CheckoutSessionExpirySweeper` TTL cron; partial so settled rows don't bloat it |

**Indexes on `webhook_deliveries`:**

| Index | Columns | Purpose |
|---|---|---|
| `webhook_deliveries_due_idx` | `(status, next_attempt_at)` WHERE `PENDING` | poller's "find due retries" scan; partial so terminal rows don't bloat it |
| `webhook_deliveries_session_idx` | `session_id` | ops/reconciliation lookup by session |

---

## Environment Variables

### reservation-api
| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `localhost` / `5432` / `app` / `app` / `reservations` | Postgres connection |
| `CLERK_SECRET_KEY` | — | Clerk secret key; used to verify session tokens server-side |
| `CLERK_PUBLISHABLE_KEY` | — | Clerk publishable key (kept for reference / future use) |
| `WEBHOOK_SECRET` | — | Shared with payment-api for HMAC |
| `PAYMENT_API_URL` | `http://localhost:3003` | Outbound calls to create checkout sessions |
| `PAYMENT_API_KEY` | — | Must match `API_KEY` in payment-api; sent as `x-api-key` when creating checkout sessions |
| `PORT` | `3000` | HTTP port |
| `CORS_ORIGIN` | `http://localhost:3001` | reservation-web origin |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP target for the OpenTelemetry SDK (Collector). Use `http://otel-collector:4318` inside docker. |
| `OTEL_DISABLED` | _(unset)_ | Set to `1` to skip SDK init entirely — useful for one-off scripts. |
| `LOG_LEVEL` | `info` | pino log level (`trace`/`debug`/`info`/`warn`/`error`). |
| `PINO_PRETTY` | _(unset)_ | Set to `1` for colorized human-readable logs in dev. Leave unset in production. |

### payment-api
| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `localhost` / `5433` / `app` / `app` / `payments` | Postgres connection. **Separate container** from reservation-api (`payments-db`, port `5433`); the two services have no shared DB state. |
| `WEBHOOK_SECRET` | — | Must match reservation-api |
| `API_KEY` | — | Must match `PAYMENT_API_KEY` in reservation-api; guards `POST /api/checkout/sessions`, `GET …/status`, and `POST /api/refunds` |
| `RESERVATION_API_URL` | `http://localhost:3000` | Webhook delivery target |
| `PUBLIC_BASE_URL` | `http://localhost:3002` | Used to construct `checkoutUrl` |
| `RESERVATION_AMOUNT` | `10.00` | Per-seat price. **payment-api is the single source of truth**: reservation-api does not carry its own copy; the resolved value is echoed in the `createSession` response so the caller can audit from the same number. |
| `PORT` | `3003` | HTTP port |
| `CORS_ORIGIN` | `http://localhost:3002` | payment-web origin |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP target for the OpenTelemetry SDK. |
| `OTEL_DISABLED` | _(unset)_ | Set to `1` to skip SDK init. |
| `LOG_LEVEL` | `info` | pino log level. |
| `PINO_PRETTY` | _(unset)_ | Set to `1` for human-readable dev logs. |

### reservation-web
| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | reservation-api base URL |
| `VITE_CLERK_PUBLISHABLE_KEY` | — | Clerk publishable key; consumed by `<ClerkProvider>` |

### payment-web
| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3003` | payment-api base URL |
| `VITE_RESERVATION_WEB_URL` | `http://localhost:3001` | Where the "back" button on the result page points |

---

## Running Tests

```bash
# reservation-api — 30 tests, 6 suites (Jest)
# Includes 8 ReconciliationWorker tests covering the refund-on-orphan path.
cd reservation-api && npm test
```

```bash
# reservation-api — concurrency integration test (3 tests; needs a live Postgres)
# Proves the SELECT ... FOR UPDATE lock against a real database: fires two
# parallel reservations for one seat and asserts exactly one 201 + one 409.
cd reservation-api && npm run test:integration
```

```bash
# payment-api — 30 tests, 6 suites (Jest)
# Includes the Postgres-backed WebhookDeliveryService suite, the
# RefundsService idempotency tests, SessionsStore tests covering the
# atomic single-use `tryClaim` guard, and the `PollRateLimitGuard` cap
# protecting the unauthenticated delivery-status poll.
cd payment-api && npm test
```

```bash
# payment-api — delivery-status integration test (4 tests; needs a live Postgres)
# Exercises CheckoutController.getDeliveryStatus end-to-end against the real
# `payments` DB: 404 path, fresh-PENDING row, terminal-DELIVERED row, and
# latest-row ordering when multiple delivery rows exist for one session.
cd payment-api && npm run test:integration
```

```bash
# reservation-web — 9 tests, 1 suite (Vitest + RTL)
cd reservation-web && npm test
```

```bash
# payment-web — 17 tests, 2 suites (Vitest + RTL)
cd payment-web && npm test
```

Coverage of service-layer branches is 75–100% across both APIs. Untested files are NestJS framework wiring (controllers, modules, DTOs) — those are intentionally left to e2e/integration tests rather than unit tests.

---

## Architecture Decisions

Non-obvious choices and the trade-offs behind them.

### Four services instead of a monolith
**Why:** to show service boundaries — auth/seat state, hosted checkout UI, and payment processing have different security postures and scaling profiles in a real system.
**Trade-off:** four `npm install`s, four ports, a webhook hop, CORS per API. Over-engineered for 3 seats; right shape for a real platform.

### Separate `reservations` table; `seats` holds only availability state
**Why:** a seat is a static entity; a reservation is a transient event with its own lifecycle. Storing `session_id`/`locked_at`/`user_id` on `seats` mixed two concerns and made columns mean different things depending on `status`. Splitting them gives a full audit trail and keeps `seats` as a clean availability cache.
**Trade-off:** queries needing both touch two tables — fine at this scope.

### Raw `pg.Pool`, no ORM
**Why:** the data model is two tables and a `SELECT ... FOR UPDATE`. An ORM would obscure the lock semantics, which is the one thing that has to be correct.

### Pessimistic locking (`SELECT FOR UPDATE`) for seat reservation
**Why:** seat reservation is low-write, low-contention, very-high-consequence. The cost of a missed serialization is double-booking; the row is locked for milliseconds. `ReservationsService.create()` opens a txn, `SELECT … FOR UPDATE` on the seat, checks `AVAILABLE`, updates seat + inserts reservation, commits. The payment-API call happens *after* commit, so the lock is never held across a network call.

**Defense in depth.** A partial unique index `reservations_one_pending_per_seat` on `(seat_id) WHERE status='PENDING_PAYMENT'` makes a second non-terminal reservation impossible at the DB level. If the service lock ever regressed, Postgres rejects with `23505` and `create()` maps it to the same `409 SEAT_ALREADY_OCCUPIED`. Verified by an integration test against a live Postgres (`npm run test:integration`).

**Trade-off considered:** optimistic concurrency with a version column would scale better but requires client retry logic — overkill for 3 seats.

### HMAC-signed webhook with retry, backoff, and observable idempotency
**Why:** simplest correct primitive for service-to-service event delivery: HMAC-SHA256 over the raw body, `timingSafeEqual` comparison. The fire-once-and-hope variant was the largest gap in the original implementation — a momentary unreachable receiver lost the event and orphaned the payment until the cron expired the seat.

**Sender (payment-api `WebhookDeliveryService`).** First attempt awaited synchronously so the response to `pay()` carries an honest `webhookDelivered` flag; failures kick off background retries at `+0s, +1s, +2s, +4s, +8s` (~15s recovery window). Each attempt is persisted in `webhook_deliveries` with `PENDING|DELIVERED|FAILED`, attempt count, last error, `next_attempt_at`. A 500ms poller drains due rows via `FOR UPDATE SKIP LOCKED` so multiple payment-api instances don't race. Persistence is what makes this **survive restarts** — a crash mid-retry resumes from the stored attempts count.

**Receiver (reservation-api `WebhooksService`).** Retries imply duplicates, so the receiver is idempotent — *and* duplicates are visible. Every accepted webhook writes `WEBHOOK_RECEIVED`, then queries the ledger for a prior outcome on the same `(session_id, event_type)`. If found, it writes `DUPLICATE_WEBHOOK / NOOP` and commits without touching state.

**Trade-off:** retries+idempotency are not a queue. If the receiver is down for the entire 15s window, the row ends `FAILED` in `webhook_deliveries` and the **reconciliation cron** picks the orphan up later (see [Reconciliation & Refund Compensation](#reconciliation--refund-compensation)). A real platform would put SQS/RabbitMQ between the services; this is the same pattern done in-process with Postgres as the durability layer.

### Failure-mode matrix
The system now distinguishes a handful of payment-failure paths and shows each as something the user can act on, rather than collapsing all of them into "Payment failed. Please try again." Every row below is exercised by a test.

| Failure | HTTP | Ledger row(s) | User sees | Recovery |
|---|---|---|---|---|
| Card declined (`5000`) | `200 {status:"failed",delivered:true}` | `WEBHOOK_RECEIVED` + `PAYMENT_FAILED` (`FAILED`); seat → `AVAILABLE` atomically | "Payment ✗ Failed" | Pick another seat or retry with `4000` |
| Card declined, webhook still retrying | `200 {status:"failed",delivered:false}` | `WEBHOOK_RECEIVED` once first attempt lands | "Payment ✗ Failed" + "releasing the seat is still in progress" | Auto-resolved by retry; cron is the backstop |
| Card succeeds, webhook still retrying | `200 {status:"success",delivered:false}` | `WEBHOOK_RECEIVED` + `PAYMENT_SUCCEEDED` once delivered | "Payment ✓ Successful" + "confirmation in progress" | Refresh after a few seconds |
| Invalid card format / wrong last4 | `400` (message contains "card") | none (validation before dispatch) | "Card must be 13–19 digits ending in 4000 or 5000." | Fix the card and resubmit |
| Replay of a settled session | `400` (message contains "already") | none | "This payment has already been completed. Refresh to see the result." | Go to the result page |
| Session expired / unknown | `404` | none | "This checkout session has expired. Please start a new reservation." | Re-reserve the seat |
| Network/CORS/abort | no response | none | "Could not reach the payment service…" | User retries the form |
| Webhook arrives twice (retry race) | `200 {received:true}` | second pass writes `WEBHOOK_RECEIVED` + `DUPLICATE_WEBHOOK` (`NOOP`); no state change | n/a — both `pay()` calls receive `delivered:true` | Idempotent by construction |
| Tampered / unsigned webhook | `401` | `SIGNATURE_REJECTED` (`REJECTED`) via pool (no txn) | n/a | Audit trail records the attempt |
| Reservation-api down for the full 15s | retry exhausted, `FAILED` in `webhook_deliveries` (payment-api DB) | `WEBHOOK_RECEIVED` never written | "Payment ✓ Successful" + "confirmation in progress" | 5-min cron releases the seat; reconciliation cron later detects the orphaned PAID session and issues an automatic refund (`REFUND_INITIATED` audit row) |

### Reconciliation & Refund Compensation
**Why:** the webhook+retry path is the *fast* path; every service boundary still leaks (retries exhausted, HMAC-rejected, post-charge rollback). The failure mode is **orphaned payment**: seat `EXPIRED`/`FAILED` while payment-api shows `PAID`. The original implementation punted on this gap; it is now closed.

**Three pieces:**
1. **Status lookup** — `GET /api/checkout/sessions/:id/status` (x-api-key) returns canonical `PENDING|PAID|FAILED|EXPIRED` so reservation-api can ask "did this charge go through?" without coupling to payment-api internals.
2. **Idempotent refund** — `POST /api/refunds {sessionId, reason}` (x-api-key), persisted in `refunds` with `UNIQUE (session_id)` + `ON CONFLICT DO UPDATE`. Calling twice returns the same row — the cron can retry as much as it wants without double-refunding. Non-PAID sessions are rejected `400`, unknown `404`.
3. **Reconciliation cron** — `ReconciliationWorker @Cron(EVERY_5_MINUTES)` SELECTs orphans: `status IN ('EXPIRED','FAILED') AND session_id IS NOT NULL AND created_at < NOW() - 10min AND NOT EXISTS (PAYMENT_SUCCEEDED | REFUND_INITIATED in ledger)`. For each, it reads the session status; if `PAID`, calls refund and writes `REFUND_INITIATED` (SUCCESS/FAILED). `PENDING`/`FAILED` are left alone — nothing to refund.

**Why the 10-minute grace window:** longer than the 5-minute seat-lock TTL, so a delayed webhook lands first and writes `PAYMENT_SUCCEEDED`, removing the row from the candidate set before the cron sees it.

**Why the ledger is the dedup key:** it already records `PAYMENT_SUCCEEDED`; adding `REFUND_INITIATED` means one `NOT EXISTS` covers both "already settled" and "already refunding". No flag column on `reservations`, no migration.

**Trade-off considered — refund at the receiver vs the cron:** the receiver only sees *late* webhooks, not the more common "never delivered" case. The cron, anchored to `reservations` state, catches both with one mechanism.

### Append-only payment audit ledger (`payment_transactions`)
**Why:** `reservations.status` is *current state*; once it moves `PENDING_PAYMENT → CONFIRMED`, the fact that a webhook arrived with what signature and payload is gone. A payment system needs tamper-evident *history* for reconciliation and disputes. The ledger is INSERT-only — one row per payment event (session creation, every webhook including signature-rejected/duplicate/stale, every expiry, every refund). `event_type` × `outcome` (`SUCCESS`/`FAILED`/`REJECTED`/`NOOP`) plus `raw_payload` carries everything. `DUPLICATE_WEBHOOK` is the audit half of the retry story; `REFUND_INITIATED` is the audit half of reconciliation.

**Atomicity:** audit rows are written **inside the same transaction** as the state change. Either both happen or neither — the trail can never silently disagree with `reservations`. A signature rejection has no state change, so it is logged standalone via the pool.

**Read path:** `GET /api/reservations/:id/audit` returns the full ordered history for the caller's own reservation (404 otherwise).

**Trade-off:** the ledger duplicates data on `reservations` (status, session_id) — that's the point. A production system would enforce append-only at the DB level (trigger or restricted role) and ship rows to immutable storage; documented, not implemented here.

### Authentication delegated to Clerk (no local identity store)
**Why:** a seat-reservation platform should not be storing passwords. Clerk owns sign-up/sign-in/sign-out, hashing, and session management. This service holds **no `users` table** — `reservations.user_id` is the Clerk user id as text. `ClerkAuthGuard` verifies the bearer token on every protected request via `@clerk/backend`'s `verifyToken`.

**Long-lived session, short-lived token.** A 90-day access token is insecure (leaked = three months with no revocation). Clerk splits it: the **session** lives in a Clerk-managed, httpOnly, server-revocable cookie configured with a **90-day Maximum lifetime** on a paid/Pro Clerk project; the **access token** the backend verifies is a ~60s JWT, refreshed transparently from that session. A stolen access token is useless within a minute; the long-lived session remains revocable centrally in Clerk.

**Session expiry path.** When the cookie expires, Clerk can no longer mint tokens; `<Show when="signed-out">` re-renders and the user lands on sign-in. As a backstop, reservation-web's axios interceptor calls `Clerk.signOut()` on any `401`, so the UI settles cleanly even if the API call races Clerk's state update.

### Persistent session store (payment-api)
**Why:** session state (`PENDING → PAID/FAILED`, 30-min TTL) is payment-api's *primary* state. Real hosted-checkout providers persist it on their side; this implementation does the same in `checkout_sessions`, so sessions survive restarts and can be served from any instance.

**Atomic single-use via conditional UPDATE.** The previous in-memory implementation was TOCTOU-prone (read → check `PENDING` → write). Replaced with `SessionsStore.tryClaim(sessionId, finalStatus)`:
```sql
UPDATE checkout_sessions SET status = $finalStatus, updated_at = NOW()
 WHERE id = $1 AND status = 'PENDING' AND expires_at > NOW()
 RETURNING *
```
Two concurrent `pay()` calls can't both claim a PENDING — exactly one row moves, the other falls through to 404/400. Single-use is now DB-enforced.

**TTL: SELECT filter + status sweep.** `get()` filters with `expires_at > NOW()` so reads stay side-effect-free. `CheckoutSessionExpirySweeper` runs every minute and transitions abandoned `PENDING` rows to `EXPIRED` — so `status='PENDING'` remains a reliable ops signal instead of mixing live and stale rows. `tryClaim()`'s `expires_at > NOW()` guard means the sweep is eventually-consistent defense in depth, not a single point of correctness.

**What `SessionsStore` does NOT do:** the *card processing*. That's the part a real provider owns and the part that disappears when payment-api is swapped for Stripe Checkout. The replaceable surface is `CheckoutService` + the `payment-web` hosted UI — not the store.

**Trade-off:** sessions now go through Postgres instead of an in-memory Map. One extra round-trip per `pay()` in the worst case; indexed PK lookups are dominated by the cross-instance scalability win.

### Mock payment-api as a Stripe Checkout stand-in
**Why:** the integration contract (create session → hosted page → HMAC-signed webhook) is structurally identical to [Stripe Checkout](https://stripe.com/docs/checkout). reservation-api never touches a card number; the boundary is the same whether the provider is this mock or Stripe.
**Production path:** swap payment-api for Stripe. `checkoutUrl` becomes a Stripe URL, the webhook becomes `Stripe-Signature`-verified, and `PAYMENT_API_*` env vars become `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`. No structural changes in reservation-api.
**Trade-off:** the shared `x-api-key` is lightweight and right for local dev; in production with a real provider it is replaced by the provider's own credential scheme.

### Single source of truth for seat pricing (payment-api)
**Why:** price lives in **one** service. Two copies of a money value invite drift, which would surface as `AMOUNT_MISMATCH` errors that look like bugs but are config skew. payment-api resolves price server-side and echoes it back (`{sessionId, checkoutUrl, amount}`); reservation-api audits the returned value. The previous caller-proposed + server-validated pattern is gone — nothing to disagree about.

### Buyer-facing delivery polling (rate-limited)
**Why:** `payment-web`'s ResultPage needs to clear the "still syncing" banner the moment the webhook lands. `GET /api/checkout/sessions/:id/delivery-status` is **unauthenticated** because the session id is already in the buyer's URL and the response carries only the delivery state machine.
**Backoff + cap.** Frontend polls with exponential backoff (1500ms → 10s, ~33 reqs/tab over 5min). `PollRateLimitGuard` caps each IP at 120/min via an in-memory sliding window — well above legitimate use.
**Trade-off:** in-memory rate state is single-instance only; horizontal scaling needs Redis `INCR`+`EXPIRE`. Swap point documented in `poll-rate-limit.guard.ts`.

### Database-per-service (two Postgres containers)
**Why:** reservation-api owns `reservations` on `:5432` (seats, reservations, audit ledger); payment-api owns `payments` on `:5433` (checkout_sessions, webhook outbox, refunds). Each service has its own pool, its own migrate script, and no credentials for the other DB — the boundary is enforced at the storage layer.
**Trade-off:** two containers is heavier than two schemas in one DB, with no cross-DB diagnostic joins. The win is the local topology matches production (each service on its own RDS instance) one-to-one.

### Background sweep (`@Cron`) for stale `PENDING_PAYMENT`
**Why:** any reliable reservation system needs a recovery path independent of the happy path. The cron is the safety net for browser crashes, dropped webhooks, abandoned tabs, payment-api downtime.
**Trade-off considered:** lazy expiry at read time would avoid a background job but produces inconsistent observed state across concurrent reads.

### Cron interval = 1 minute, lock TTL = 5 minutes
**Why:** 5 minutes is long enough that real users won't be cut off mid-checkout (the average payment form takes under a minute); 1-minute polling means worst-case 6-minute total wait before a stuck seat is released.
**Trade-off:** values are configurable. In production these should be tuned with observed checkout-completion times, not assumed.


### Plain CSS, no design system, no Tailwind
**Why:** the scope is two pages per app. A design system here would be visual fluff masking the engineering question.

---

## Deployment

This is deliberately an **on-prem / locally-runnable** deployment, optimized for reviewer verifiability rather than production operation.

**Why local:** the reviewer clones, runs documented commands, and observes the real system end-to-end (DB state, logs, webhooks) in minutes — no cloud accounts, no live URLs to keep up.

**What's containerized:** both Postgres instances via `docker compose up -d`. The four Node services run directly via `npm run` so each service's logs are inspectable in its own terminal and individual services can be restarted in isolation — "easy to start" containerization here would make it harder to inspect.

**Production path:**
- Each service into its own image, orchestrated (K8s/ECS) with health/readiness probes.
- Each Postgres container → a managed instance (RDS / Cloud SQL); the database-per-service topology is unchanged.
- Secrets from a secret manager, not `.env` files. TLS at a reverse proxy. Web apps built to static + CDN. Centralized logging/metrics.

---

## Security Considerations

### What is protected

- **Credentials:** none stored. Identity, hashing, session lifecycle delegated to Clerk; no `users` table.
- **Session tokens:** ~60s Clerk JWTs verified server-side by `ClerkAuthGuard`. The long-lived session (7 days on Clerk free; 90 on Pro) lives in an httpOnly cookie and is revocable; no long-lived access token is ever issued.
- **SQL injection:** all queries parameterized (`$1`, `$2`…); no string concatenation against user input.
- **Webhook authenticity:** HMAC-SHA256 of raw body vs `WEBHOOK_SECRET` with `timingSafeEqual`; length mismatches rejected before comparison. Rejections are not silently dropped — a `SIGNATURE_REJECTED` audit row is written, so tampering is observable.
- **Payment audit trail:** every payment event appends one immutable row to `payment_transactions`, written atomically with the state change.
- **CORS:** explicit allowlist per API; not `*`.
- **Input validation:** `class-validator` on all DTOs via global `ValidationPipe`; card format validated by regex before any business logic.
- **Seat double-booking:** two layers — `SELECT ... FOR UPDATE` + partial unique index `reservations_one_pending_per_seat`.
- **Service-to-service auth:** `POST /api/checkout/sessions` (and refund/status endpoints) require `x-api-key`. The key lives in reservation-api's server env and never reaches the browser — only the resulting `checkoutUrl` does. Blocks an external caller from forging a session for someone else's seat.
- **Stale-payment webhook isolation:** the handler UPDATEs `reservations WHERE session_id=$1 AND status='PENDING_PAYMENT' RETURNING seat_id`, then updates `seats` using only that returned `seat_id` — never the (untrusted) payload. A stale event matches no row and touches nothing.
- **Payment session single-use & TTL (DB-enforced):** `pay()` is a single conditional UPDATE (`WHERE status='PENDING' AND expires_at > NOW()`); concurrent calls cannot both succeed; 30-min TTL bounds the replay window.


### Threat model notes

- The **demo card numbers** (`4000` = success, `5000` = failure) are a deliberate mock contract — there is no real card data anywhere in the system.
- The **webhook secret is symmetric**, which is fine when both ends are operated by the same team. A real third-party payment provider would use asymmetric signatures (RSA/Ed25519) so the secret is never shared.
- The **Clerk secret key** and **webhook secret** are loaded from env. In production these belong in a secret manager (AWS Secrets Manager, Vault, Doppler), not a `.env` file.

---

## Failure Modes & Reliability

The HTTP-level matrix lives in [the Failure-mode matrix above](#failure-mode-matrix). Additional reliability scenarios not covered there:

| Scenario | Behavior |
|---|---|
| **Two users click Book on the same seat simultaneously** | `SELECT ... FOR UPDATE` serializes the requests. One gets `201`, the other `409 SEAT_ALREADY_OCCUPIED`; the partial unique index is the DB-level backstop. Verified by an integration test against a live Postgres. |
| **User starts payment and closes the tab** | Seat sits in `PENDING_PAYMENT`; the expiry cron releases it after 5 minutes. |
| **Stale webhook from User A while seat is now held by User B** | `AND session_id = $1 AND status='PENDING_PAYMENT'` matches no row; seat UPDATE is skipped. User B's reservation is untouched because the seat_id is sourced from the matched row, never the payload. |
| **Late webhook for a reservation that has since `EXPIRED`** | UPDATE matches no row. payment-api still shows `PAID`; the reconciliation cron picks the orphan up (10-min grace) and issues an automatic refund — see [Reconciliation & Refund Compensation](#reconciliation--refund-compensation). |
| **`pay()` replayed against a settled session** | payment-api rejects `400 alreadyProcessed` via the atomic claim's `WHERE status='PENDING'` guard. No second webhook is fired. |
| **Session accessed after 30-minute TTL** | `SessionsStore.get()` filters `expires_at > NOW()` and returns `undefined` → `404`. |

**Remaining out-of-scope items:** a true DLQ for refunds that fail repeatedly (the audit row records `FAILED` but there's no human-review handoff), and per-attempt retries on the refund call (the cron retries naturally every 5 min). Both are documented in [docs/scope-not-implemented/booking_system.feature](docs/scope-not-implemented/booking_system.feature).

---

## Observability — traces, metrics, logs, SLOs

The transaction path is instrumented end-to-end with OpenTelemetry. The intent is **metric → trace → log drill-down**: a latency spike on the SLO dashboard is one click away from the offending trace, which is one click away from the log lines for that request.

### Local stack

The full stack — Collector, Prometheus, Tempo, Loki, Grafana — is opt-in under a docker-compose profile so a normal `docker compose up` brings up just the two databases.

```bash
# Default (databases only — what you already had)
docker compose up

# With the observability stack (heavier; ~6 containers)
docker compose --profile observability up

# Or only the observability stack, against an existing pair of DBs
docker compose --profile observability up otel-collector prometheus tempo loki grafana
```

| Service | URL | Purpose |
|---|---|---|
| Grafana | http://localhost:3030 | Dashboards & datasource UIs. Anonymous auth is enabled with admin role for local convenience. Port 3030 is used because 3000-3003 are claimed by the four app services (reservation-api/web, payment-api/web). |
| Prometheus | http://localhost:9090 | Metrics backend |
| Tempo | http://localhost:3200 | Trace backend (queried via Grafana) |
| Loki | http://localhost:3100 | Log backend (queried via Grafana) |
| OTel Collector | `localhost:4317` (gRPC), `localhost:4318` (HTTP) | What the apps send signals to |

The default dashboard is **Linkz → SLO Overview** ([slo-overview.json](observability/grafana/dashboards/slo-overview.json)). It tracks the four SLIs from [docs/SLA.md](docs/SLA.md): reservation availability, p95 latency, payment success rate, webhook delivery success rate — plus error-budget remaining and 1h/6h burn-rate panels.

### What gets instrumented

| Signal | reservation-api | payment-api |
|---|---|---|
| **HTTP server** | auto | auto |
| **Outbound `fetch`** | auto (incl. payment-api call) | auto (incl. webhook delivery) |
| **`pg` queries** | auto | auto |
| **Manual spans** | `reservation.create` + child `reservation.lock_seat` + child `payment_api.create_session`; `webhook.handle`; `cron.seat_expiry_sweep`; `cron.reconciliation` | `checkout.pay`; `cron.checkout_session_expiry`; `webhook.deliver_attempt`; `refund.create` |
| **Metrics** | `reservations_total`, `reservation_request_duration_seconds`, `payment_outcomes_total`, `webhook_signature_rejected_total`, `seat_expiry_swept_total`, `reconciliation_refunds_total` | `payment_attempts_total`, `payment_request_duration_seconds`, `webhook_delivery_attempts_total`, `webhook_delivery_final_total`, `checkout_sessions_expired_total`, `refund_requests_total` |
| **Logs** | pino JSON → Collector → Loki, with `trace_id`/`span_id` injected by the active OpenTelemetry context | same |

### Drill-down wiring

| From | To | How |
|---|---|---|
| Prometheus histogram exemplar | Tempo trace | `exemplarTraceIdDestinations` in the datasource provisioning |
| Tempo trace | Loki logs | `tracesToLogsV2` with `filterByTraceID` on the same `trace_id` |
| Loki log line | Tempo trace | `derivedFields` regex matches the `trace_id` field |

Single click path: **dashboard panel → exemplar dot → Tempo trace → "View logs" → Loki query**, all scoped to one `trace_id`.

### Trade-off

Six containers + ~1 GB RAM is overkill for a 3-seat demo. It's on the page to demonstrate the *production shape*, not because it's needed to run the service. Skipping the profile leaves the SDK as a no-op when there's no Collector to talk to.

### Files

- [observability/collector/config.yaml](observability/collector/config.yaml) — receivers / processors / exporters
- [observability/prometheus/prometheus.yml](observability/prometheus/prometheus.yml) — scrape config
- [observability/tempo/tempo.yaml](observability/tempo/tempo.yaml), [observability/loki/loki-config.yaml](observability/loki/loki-config.yaml) — single-binary, local-fs backends
- [observability/grafana/provisioning/](observability/grafana/provisioning/) — auto-provisioned datasources & dashboard loader
- [observability/grafana/dashboards/slo-overview.json](observability/grafana/dashboards/slo-overview.json) — the SLO dashboard
- [docs/SLA.md](docs/SLA.md) — SLIs, SLOs, error-budget policy, burn-rate alert policy

### App-side files

- `*/src/observability/tracing.ts` — OTel NodeSDK bootstrap (imported *first* in `main.ts` so auto-instrumentation patches `http`/`pg` before they're loaded)
- `*/src/observability/logger.ts` — pino logger with trace-id mixin
- `*/src/observability/metrics.ts` — typed metric handles + `recordDuration` helper
- `*/src/observability/tracer.ts` — `withSpan(name, attrs, fn)` helper that records OK/ERROR status from the resolved/rejected promise
