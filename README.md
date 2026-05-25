# Seat Reservation Platform

A minimal seat reservation platform consisting of four services. The scope is deliberately small (3 seats) so the README can focus on the *engineering decisions* — what was built, what was deferred, and why.

Authentication is delegated to [Clerk](https://clerk.com): this platform stores no passwords and runs no identity database. See [Architecture Decisions](#architecture-decisions) for why, and how the long-lived-session requirement is met with short-lived access tokens.

Gherkin acceptance criteria: [docs/acceptance-criteria/](docs/acceptance-criteria/). Explicitly out-of-scope scenarios (full idempotency-key handling, DLQ routing): [docs/scope-not-implemented/](docs/scope-not-implemented/).

> **Update.** A follow-up iteration added the reconciliation/refund compensation loop originally documented as "out of scope" — see [Reconciliation & Refund Compensation](#reconciliation--refund-compensation). payment-api now owns its own Postgres database (`payments`, port `5433`) with a webhook-delivery outbox and a refunds table; reservation-api runs a cron that detects orphaned PAID sessions and asks payment-api for an idempotent refund.

## Contents

1. [Quick Start](#quick-start)
2. [End-to-End Flow](#end-to-end-flow)
3. [API Reference](#api-reference)
4. [Database Schema](#database-schema)
5. [Environment Variables](#environment-variables)
6. [Running Tests](#running-tests)
7. [Architecture Decisions](#architecture-decisions)
8. [Deployment](#deployment)
9. [Security Considerations](#security-considerations)
10. [Failure Modes & Reliability](#failure-modes--reliability)
11. [Observability](#observability--traces-metrics-logs-slos)

## Quick Start

### Prerequisites
- Docker & Docker Compose

### 1. Clerk keys

Create a [Clerk](https://clerk.com) application and copy its publishable + secret keys into the `.env` files (see [Environment Variables](#environment-variables)).

> **For reviewers:** my personal Clerk keys will be shared over email. These are attached to a **free (non-Pro) Clerk account**, so session **Maximum lifetime is the free-tier 7 days, not 90**. The architecture (long-lived session cookie + short-lived access JWT) is unchanged; only the cookie's max lifetime differs.

**For the 90-day session requirement,** use a paid Clerk project with **Sessions → Maximum lifetime = 90 days**. The long-lived session remains a revocable Clerk-managed cookie; the backend access token remains a short-lived JWT.

### 2. Configure environment

```bash
cp reservation-api/.env.example reservation-api/.env
cp payment-api/.env.example     payment-api/.env
cp reservation-web/.env.example reservation-web/.env
cp payment-web/.env.example     payment-web/.env
```

Fill the Clerk keys in `reservation-api/.env` and `reservation-web/.env`.

> `WEBHOOK_SECRET` must be **identical** in `reservation-api/.env` and `payment-api/.env`, and `PAYMENT_API_KEY` (reservation-api) must equal `API_KEY` (payment-api). Both pairs already match in the committed `.env.example` files — only rotate them (in lockstep) before any real deployment.

### 3. Start the platform

```bash
docker compose up -d --build                            # 2 databases + 4 app services
docker compose --profile observability up -d --build    # + Collector / Prom / Tempo / Loki / Grafana
```

Open <http://localhost:3001>. Each API runs its idempotent migration on startup ([reservation-api/sql/init.sql](reservation-api/sql/init.sql), [payment-api/sql/init.sql](payment-api/sql/init.sql)) and the three seats (`A1`, `A2`, `A3`) are seeded. There are no demo users — sign up through the UI.

reservation-api → `reservations` DB on `:5432`; payment-api → `payments` DB on `:5433`. Per-service logs: `docker compose logs -f <service>`.

### Reset to a clean slate

```bash
docker compose --profile observability down -v --remove-orphans
```

---

## End-to-End Flow

1. Open <http://localhost:3001>
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

Auth is Clerk; no login endpoint. Protected routes expect `Authorization: Bearer <token>`.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `GET`  | `/api/seats` | Clerk | — | `[{id, status}]` |
| `POST` | `/api/reservations` | Clerk | `{seatId}` | `201 {checkoutUrl}` / `409 SEAT_ALREADY_OCCUPIED` / `502` |
| `GET`  | `/api/reservations/:id/audit` | Clerk | — | `200 [{event_type, outcome, …}]` / `404` |
| `POST` | `/api/webhooks/payment` | HMAC `x-signature` | `{event, sessionId, seatId, userId}` | `{received:true}` / `401` / `400` |

### payment-api (`:3003`)

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `POST` | `/api/checkout/sessions` | `x-api-key` | `{seatId, userId}` | `{sessionId, checkoutUrl, amount}` / `401` |
| `GET`  | `/api/checkout/sessions/:id` | — | — | `{seatId, amount}` / `404` |
| `GET`  | `/api/checkout/sessions/:id/status` | `x-api-key` | — | `{sessionId, status, seatId, userId, amount}` / `404` — used by reconciliation cron |
| `GET`  | `/api/checkout/sessions/:id/delivery-status` | per-IP 120/min | — | `{status, attempts, nextAttemptAt, terminalDelivered}` — buyer-facing poll |
| `POST` | `/api/checkout/sessions/:id/pay` | — | `{cardNumber}` | `{status, webhookDelivered, deliveryId}` / `400` / `404` |
| `POST` | `/api/refunds` | `x-api-key` | `{sessionId, reason?}` | `{id, session_id, amount, status:'REFUNDED'}` / `400` / `404`. Idempotent |
| `GET`  | `/api/refunds/:sessionId` | `x-api-key` | — | `{...refund}` / `404` |

**Pricing source of truth:** `POST /api/checkout/sessions` takes no `amount`; payment-api resolves it from `RESERVATION_AMOUNT` and echoes it back so the caller can audit from the same number.

**`webhookDelivered`** is `true` when reservation-api acked the webhook on the synchronous first attempt; `false` means background retry (5 attempts, ~15s). The frontend forwards this as `?delivered=0|1` so the result page can show "still being confirmed" instead of pretending the flow is final.

---

## Database Schema

Two Postgres containers, strict database-per-service. Each service owns its own pool, migration script, and tables; cross-service communication is HTTP-only. In production each DB would move to its own managed instance with no application change.

| DB (container) | Tables | Owner | Schema |
|---|---|---|---|
| `reservations` (`:5432`) | `seats`, `reservations`, `payment_transactions` (append-only audit ledger) | reservation-api | [reservation-api/sql/init.sql](reservation-api/sql/init.sql) |
| `payments` (`:5433`) | `checkout_sessions` (PENDING → PAID/FAILED/EXPIRED, atomic single-use claim + TTL sweep), `webhook_deliveries` (sender-side outbox), `refunds` (idempotent on `session_id`) | payment-api | [payment-api/sql/init.sql](payment-api/sql/init.sql) |

There is no `users` table — identity is owned by Clerk, and `reservations.user_id` stores the Clerk user id (e.g. `user_2ab…`) as opaque text.

**Key invariants enforced at the DB layer:**
- `reservations_one_pending_per_seat` — UNIQUE partial index on `(seat_id) WHERE status='PENDING_PAYMENT'`. DB-level double-booking guard; complements the `SELECT FOR UPDATE` in the service.
- `payment_transactions` is INSERT-only — one row per payment event, written **in the same transaction as the state change**. `event_type` covers creation / webhook received / payment success+fail / signature rejected / duplicate / expired / refund initiated.
- `checkout_sessions` single-use via conditional UPDATE (`WHERE status='PENDING' AND expires_at > NOW()`); concurrent `pay()` cannot both succeed.
- `refunds.session_id` UNIQUE + `ON CONFLICT DO UPDATE` makes `POST /api/refunds` idempotent.

Partial indexes back the cron sweeps (`reservations_sweep_idx`, `checkout_sessions_expiry_idx`, `webhook_deliveries_due_idx`) so settled rows don't bloat them. Full DDL — columns, types, checks, indexes — is in the init scripts linked above.

---

## Environment Variables

Full list per service in each `.env.example`. The committed examples are dev-ready out of the box.

**Two values must match across services** (both pre-aligned in `.env.example`; rotate in lockstep):
- `WEBHOOK_SECRET` — `reservation-api` ↔ `payment-api` (HMAC of webhook body)
- `PAYMENT_API_KEY` (reservation-api) = `API_KEY` (payment-api) — `x-api-key` for service-to-service calls

**Operator-relevant:**
- `RESERVATION_AMOUNT` (payment-api, default `10.00`) — per-seat price. **payment-api is the single source of truth**; reservation-api audits the echoed value.
- `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` (reservation-api); `VITE_CLERK_PUBLISHABLE_KEY` (reservation-web)
- `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`; use `http://otel-collector:4318` inside docker). `OTEL_DISABLED=1` skips SDK init.
- `LOG_LEVEL` (pino, default `info`); `PINO_PRETTY=1` for human-readable dev logs.
- `TRUST_PROXY` (payment-api, unset by default) — accepts Express' [`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) syntax (`1`, `loopback`, CIDR list, etc.). **Set this when payment-api runs behind any reverse proxy** (ALB, nginx, k8s ingress) so `PollRateLimitGuard` keys off the real client IP instead of bucketing every request under the proxy's address. Leave unset on bare deployments — with no proxy, a spoofed `X-Forwarded-For` would let any client pick their own bucket.

---

## Running Tests

```bash
cd reservation-api && npm test                 # 30 tests, 6 suites (Jest); incl. ReconciliationWorker (refund-on-orphan)
cd reservation-api && npm run test:integration # 3 tests; needs live Postgres; SELECT FOR UPDATE under real contention

cd payment-api && npm test                     # 30 tests, 6 suites (Jest); WebhookDeliveryService, RefundsService idempotency,
                                               #                            SessionsStore.tryClaim, PollRateLimitGuard
cd payment-api && npm run test:integration     # 4 tests; live Postgres; getDeliveryStatus end-to-end

cd reservation-web && npm test                 # 9 tests (Vitest + RTL)
cd payment-web    && npm test                  # 17 tests (Vitest + RTL)
```

Service-layer branch coverage is 75–100% across both APIs. Untested files are NestJS framework wiring (controllers, modules, DTOs) — intentionally left to e2e/integration tests.

---

## Architecture Decisions

Non-obvious choices and the trade-offs behind them.

### Four services instead of a monolith
To show service boundaries — auth/seat state, hosted checkout UI, and payment processing have different security postures and scaling profiles in a real system. Over-engineered for 3 seats; right shape for a real platform.

### Separate `reservations` table; `seats` holds only availability state
A seat is a static entity; a reservation is a transient event with its own lifecycle. Putting `session_id`/`locked_at`/`user_id` on `seats` mixed two concerns and made columns mean different things depending on `status`. Splitting them gives a full audit trail and keeps `seats` as a clean availability cache. Trade-off: queries needing both touch two tables.

### Pessimistic locking for seat reservation
Seat reservation is low-write, very-high-consequence. `ReservationsService.create()` opens a txn, `SELECT … FOR UPDATE` on the seat, checks `AVAILABLE`, updates seat + inserts reservation, commits. The payment-API call happens *after* commit, so the lock is never held across a network call.

**Defense in depth.** The partial unique index `reservations_one_pending_per_seat` makes a second non-terminal reservation impossible at the DB level. If the service lock ever regressed, Postgres rejects with `23505` and `create()` maps it to the same `409 SEAT_ALREADY_OCCUPIED`. Verified by `npm run test:integration` against a live Postgres. Optimistic concurrency would scale better at thousands of seats, but requires client retry logic — overkill here.

### HMAC-signed webhook with persistent retry + idempotent receiver
HMAC-SHA256 over the raw body, `timingSafeEqual` comparison. **Sender (`WebhookDeliveryService`):** first attempt awaited synchronously so `pay()` carries an honest `webhookDelivered` flag; failures kick off retries at `+0/1/2/4/8s` (~15s window). Each attempt persisted in `webhook_deliveries` with attempt count, last error, `next_attempt_at`. A 500ms poller drains due rows via `FOR UPDATE SKIP LOCKED` so multiple payment-api instances don't race. Persistence is what makes this **survive restarts**.

**Receiver (`WebhooksService`).** Retries imply duplicates, so the receiver is idempotent — *and* duplicates are visible. Every accepted webhook writes `WEBHOOK_RECEIVED`, then queries the ledger for a prior outcome on the same `(session_id, event_type)`. Duplicates write `DUPLICATE_WEBHOOK / NOOP` and commit without touching state.

**Trade-off.** Retries+idempotency are not a queue. If the receiver is down for the full 15s the row ends `FAILED` in `webhook_deliveries`, and the reconciliation cron picks the orphan up later. A real platform would put SQS/RabbitMQ between the services; this is the same pattern done in-process with Postgres as the durability layer.

### Reconciliation & Refund Compensation
The webhook path is the *fast* path; every service boundary still leaks (retries exhausted, HMAC-rejected, post-charge rollback). The failure mode is **orphaned payment**: seat `EXPIRED`/`FAILED` while payment-api shows `PAID`. Three pieces close the gap:

1. **Status lookup** — `GET /api/checkout/sessions/:id/status` (x-api-key) returns canonical `PENDING|PAID|FAILED|EXPIRED` without coupling to payment-api internals.
2. **Idempotent refund** — `POST /api/refunds` persisted with `UNIQUE (session_id)` + `ON CONFLICT DO UPDATE`. Calling twice returns the same row; the cron can retry as much as it wants without double-refunding. Non-PAID rejected `400`, unknown `404`.
3. **Reconciliation cron** — `ReconciliationWorker @Cron(EVERY_5_MINUTES)` selects orphans: `status IN ('EXPIRED','FAILED') AND session_id IS NOT NULL AND created_at < NOW() - 10min AND NOT EXISTS (PAYMENT_SUCCEEDED | REFUND_INITIATED in ledger)`. For each, it reads the session status; if `PAID`, refunds and writes `REFUND_INITIATED`.

The 10-minute grace window is longer than the 5-minute seat-lock TTL, so a delayed webhook lands first and removes the row from the candidate set. The ledger is the dedup key: one `NOT EXISTS` covers both "already settled" and "already refunding" — no flag column, no migration on `reservations`. Refund at the cron (anchored to `reservations` state) catches both "late webhook" and "never delivered"; a receiver-side refund would only catch the first.

### Append-only payment audit ledger (`payment_transactions`)
`reservations.status` is *current state*; once it moves `PENDING_PAYMENT → CONFIRMED`, the fact that a webhook arrived with what signature and payload is gone. A payment system needs tamper-evident *history* for reconciliation and disputes. One INSERT-only row per payment event (creation, every webhook including rejected/duplicate/stale, every expiry, every refund). `event_type` × `outcome` (`SUCCESS`/`FAILED`/`REJECTED`/`NOOP`) plus `raw_payload` carries everything. Written **in the same transaction as the state change** — the trail can never silently disagree with `reservations`. Read path: `GET /api/reservations/:id/audit`. A production system would enforce append-only at the DB level (trigger/restricted role) and ship rows to immutable storage.

### Authentication delegated to Clerk
A seat-reservation platform should not be storing passwords. Clerk owns sign-up/sign-in/sign-out, hashing, and session management. No `users` table; `reservations.user_id` is the Clerk user id as text. `ClerkAuthGuard` verifies the bearer token via `@clerk/backend`'s `verifyToken`.

**Long-lived session, short-lived token.** A 90-day access token is insecure (leaked = three months with no revocation). Clerk splits it: the **session** lives in an httpOnly, server-revocable cookie configured with 90-day max lifetime on a paid Clerk project; the **access token** the backend verifies is a ~60s JWT, refreshed transparently from that session. A stolen access token is useless within a minute; the long-lived session remains revocable centrally. As a backstop, reservation-web's axios interceptor calls `Clerk.signOut()` on any `401`.

### Persistent session store (payment-api)
Session state (`PENDING → PAID/FAILED`, 30-min TTL) is payment-api's *primary* state. Real hosted-checkout providers persist it on their side; this implementation does the same in `checkout_sessions`. **Atomic single-use** via `SessionsStore.tryClaim`:
```sql
UPDATE checkout_sessions SET status = $finalStatus, updated_at = NOW()
 WHERE id = $1 AND status = 'PENDING' AND expires_at > NOW()
 RETURNING *
```
Two concurrent `pay()` calls cannot both claim — exactly one row moves, the other falls through to 404/400. **TTL:** `get()` filters `expires_at > NOW()` so reads stay side-effect-free; `CheckoutSessionExpirySweeper` transitions abandoned `PENDING` rows to `EXPIRED` every minute so `status='PENDING'` remains a reliable ops signal. What `SessionsStore` does NOT do: card processing — that's the part a real provider owns and the part that disappears when payment-api is swapped for Stripe Checkout. The replaceable surface is `CheckoutService` + the `payment-web` hosted UI.

### Mock payment-api as a Stripe Checkout stand-in
The integration contract (create session → hosted page → HMAC-signed webhook) is structurally identical to [Stripe Checkout](https://stripe.com/docs/checkout). reservation-api never touches a card number. Production path: swap payment-api for Stripe; `checkoutUrl` becomes a Stripe URL, the webhook becomes `Stripe-Signature`-verified, and `PAYMENT_API_*` env vars become `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`. No structural changes in reservation-api. The shared `x-api-key` is lightweight and right for local dev; production with a real provider replaces it with the provider's credential scheme.

### Single source of truth for seat pricing (payment-api)
Price lives in **one** service. Two copies of a money value invite drift, which surfaces as `AMOUNT_MISMATCH` errors that look like bugs but are config skew. payment-api resolves price server-side and echoes it back (`{sessionId, checkoutUrl, amount}`); reservation-api audits the returned value.

### Buyer-facing delivery polling (rate-limited)
`payment-web`'s ResultPage needs to clear the "still syncing" banner the moment the webhook lands. `GET /api/checkout/sessions/:id/delivery-status` is **unauthenticated** because the session id is already in the buyer's URL and the response carries only the delivery state machine. Frontend polls with exponential backoff (1500ms → 10s, ~33 reqs/tab over 5 min); `PollRateLimitGuard` caps each IP at 120/min via an in-memory sliding window. Horizontal scaling needs Redis `INCR`+`EXPIRE` — swap point documented in `poll-rate-limit.guard.ts`.

### Database-per-service (two Postgres containers)
Each service has its own pool, its own migrate script, and no credentials for the other DB — the boundary is enforced at the storage layer. Two containers is heavier than two schemas in one DB and gives up cross-DB diagnostic joins; the win is the local topology matches production (each service on its own RDS instance) one-to-one.

### Background sweep + cron interval (1 min poll, 5 min lock TTL)
Any reliable reservation system needs a recovery path independent of the happy path — the cron is the safety net for browser crashes, dropped webhooks, abandoned tabs, payment-api downtime. 5 minutes is long enough that real users won't be cut off mid-checkout; 1-minute polling means worst-case 6 minutes before a stuck seat is released. Configurable; in production tune from observed checkout-completion times. Lazy expiry at read time would avoid the background job but produces inconsistent observed state across concurrent reads.

### Plain CSS, no design system
Scope is two pages per app. A design system here would be visual fluff masking the engineering question.

---

## Deployment

Ships as a deployment-ready `docker compose` stack — one command (`docker compose up -d --build`) brings the entire platform up: two Postgres databases, four app services, and (under the `observability` profile) the full Collector/Prom/Tempo/Loki/Grafana telemetry pipeline. The compose topology *is* the deployment unit: one image per service, isolated databases, no shared state outside the network. The same artifact runs identically on a laptop, a CI host, or a single-VM staging environment — no config drift between "dev" and "real." Per-service logs stay inspectable via `docker compose logs -f <service>`; any service can be restarted in isolation with `docker compose restart <service>` for fault injection.

**Production path.** Lift each image into a real orchestrator (K8s / ECS) with health and readiness probes; swap each Postgres container for a managed instance (RDS / Cloud SQL) with no application change; pull secrets from a secret manager (AWS Secrets Manager / Vault / Doppler) instead of `.env`; terminate TLS at a reverse proxy; build web apps to static assets behind a CDN; point the existing OTel pipeline at hosted backends. Every substitution is at the *infrastructure* boundary — the application code is unaware of what's hosting it because the boundaries were already drawn at the container and DB level.

---

## Security Considerations

- **Credentials:** none stored. Identity, hashing, session lifecycle delegated to Clerk; no `users` table.
- **Session tokens:** ~60s Clerk JWTs verified server-side. The long-lived session (7d free / 90d Pro) is an httpOnly, revocable cookie; no long-lived access token is ever issued.
- **SQL injection:** all queries parameterized (`$1`, `$2`…); no string concatenation against user input.
- **Webhook authenticity:** HMAC-SHA256 vs `WEBHOOK_SECRET` with `timingSafeEqual`; length-mismatched signatures rejected before comparison. Rejections are observable — a `SIGNATURE_REJECTED` audit row is written.
- **Seat double-booking:** two layers — `SELECT FOR UPDATE` + partial unique index `reservations_one_pending_per_seat`.
- **Service-to-service auth:** `POST /api/checkout/sessions`, status lookup, and refund endpoints require `x-api-key`. The key lives in reservation-api's server env and never reaches the browser — only the resulting `checkoutUrl` does.
- **Stale-payment webhook isolation:** the handler UPDATEs `reservations WHERE session_id=$1 AND status='PENDING_PAYMENT' RETURNING seat_id`, then updates `seats` using only that returned `seat_id` — never the (untrusted) payload. A stale event matches no row and touches nothing.
- **Payment session single-use & TTL:** DB-enforced via the conditional UPDATE; 30-min TTL bounds the replay window.
- **Input validation:** `class-validator` on all DTOs via global `ValidationPipe`; card format validated by regex before any business logic.
- **CORS:** explicit allowlist per API; not `*`.

**Threat-model notes.** Demo card numbers (`4000`/`5000`) are a deliberate mock contract — no real card data. Webhook secret is symmetric, fine when both ends are operated by the same team; a real third-party provider would use asymmetric signatures (RSA/Ed25519). Clerk secret + webhook secret belong in a secret manager (AWS Secrets Manager, Vault, Doppler) in production, not `.env`.

---

## Failure Modes & Reliability

Every row below is exercised by a test.

| Failure | HTTP | Ledger row(s) | User sees | Recovery |
|---|---|---|---|---|
| Card declined (`5000`) | `200 {status:"failed",delivered:true}` | `WEBHOOK_RECEIVED` + `PAYMENT_FAILED`; seat → `AVAILABLE` atomically | "Payment ✗ Failed" | Pick another seat or retry with `4000` |
| Card declined, webhook still retrying | `200 {status:"failed",delivered:false}` | `WEBHOOK_RECEIVED` once first attempt lands | "Payment ✗ Failed" + "releasing the seat is still in progress" | Auto-resolved by retry; cron is backstop |
| Card succeeds, webhook still retrying | `200 {status:"success",delivered:false}` | `WEBHOOK_RECEIVED` + `PAYMENT_SUCCEEDED` once delivered | "Payment ✓ Successful" + "confirmation in progress" | Refresh after a few seconds |
| Invalid card format / wrong last4 | `400` (message contains "card") | none | "Card must be 13–19 digits ending in 4000 or 5000." | Fix the card and resubmit |
| Replay of a settled session | `400` (message contains "already") | none | "Already completed. Refresh to see the result." | Go to the result page |
| Session expired / unknown | `404` | none | "Session expired. Please start a new reservation." | Re-reserve the seat |
| Network/CORS/abort | no response | none | "Could not reach the payment service…" | User retries the form |
| Webhook arrives twice (retry race) | `200 {received:true}` | second pass writes `WEBHOOK_RECEIVED` + `DUPLICATE_WEBHOOK / NOOP`; no state change | n/a — both `pay()` calls receive `delivered:true` | Idempotent by construction |
| Tampered / unsigned webhook | `401` | `SIGNATURE_REJECTED / REJECTED` via pool (no txn) | n/a | Audit trail records the attempt |
| Reservation-api down for full 15s | retry exhausted, `FAILED` in `webhook_deliveries` (payment-api DB) | `WEBHOOK_RECEIVED` never written | "Payment ✓ Successful" + "confirmation in progress" | 5-min cron releases the seat; reconciliation cron later issues automatic refund (`REFUND_INITIATED`) |

**Additional reliability scenarios:**
- **Two users click Book on the same seat:** `SELECT FOR UPDATE` serializes. One `201`, one `409 SEAT_ALREADY_OCCUPIED`. Partial unique index is the DB backstop. Verified by integration test.
- **User starts payment and closes the tab:** seat sits `PENDING_PAYMENT`; the expiry cron releases it after 5 minutes.
- **Stale webhook from User A while seat is now held by User B:** UPDATE `WHERE session_id=$1 AND status='PENDING_PAYMENT'` matches no row. User B untouched because `seat_id` is sourced from the matched row, never the payload.
- **Late webhook for a reservation that has since `EXPIRED`:** UPDATE matches no row; payment-api still shows `PAID`; reconciliation cron picks the orphan up (10-min grace) and issues an automatic refund.
- **`pay()` replayed against a settled session:** payment-api rejects `400 alreadyProcessed` via the atomic claim's `WHERE status='PENDING'` guard. No second webhook fired.
- **Session accessed after 30-min TTL:** `SessionsStore.get()` filters `expires_at > NOW()` and returns `undefined` → `404`.

**Remaining out-of-scope:** a true DLQ for refunds that fail repeatedly (the audit row records `FAILED` but there's no human-review handoff), and per-attempt retries on the refund call (the cron retries naturally every 5 min). Both documented in [docs/scope-not-implemented/booking_system.feature](docs/scope-not-implemented/booking_system.feature).

---

## Observability — traces, metrics, logs, SLOs

The transaction path is instrumented end-to-end with OpenTelemetry. Intent is **metric → trace → log drill-down**: a latency spike on the SLO dashboard is one click from the offending trace, which is one click from the logs for that request.

### Local stack

Opt-in under a docker-compose profile — a normal `docker compose up` brings up only the platform (two DBs + four app services).

```bash
docker compose --profile observability up   # + Collector, Prom, Tempo, Loki, Grafana
```

| Service | URL | Purpose |
|---|---|---|
| Grafana | http://localhost:3030 | Dashboards (port 3030 because 3000–3003 are claimed by the app services) |
| Prometheus | http://localhost:9090 | Metrics backend |
| Tempo | http://localhost:3200 | Trace backend |
| Loki | http://localhost:3100 | Log backend |
| OTel Collector | `4317` gRPC / `4318` HTTP | Where the apps send signals |

Default dashboard: **Linkz → SLO Overview** ([slo-overview.json](observability/grafana/dashboards/slo-overview.json)). Tracks the four SLIs from [docs/SLA.md](docs/SLA.md): reservation availability, p95 latency, payment success rate, webhook delivery success rate — plus error-budget remaining and 1h/6h burn-rate panels.

### What's instrumented
- **Auto:** HTTP server, outbound `fetch` (incl. cross-service calls), `pg` queries.
- **Manual spans:** `reservation.create` (+ child `reservation.lock_seat`, `payment_api.create_session`), `webhook.handle`, `cron.seat_expiry_sweep`, `cron.reconciliation`; `checkout.pay`, `cron.checkout_session_expiry`, `webhook.deliver_attempt`, `refund.create`.
- **Metrics:** request duration histograms + counters for reservations, payment outcomes, signature rejections, webhook delivery attempts/final, refunds, session expirations.
- **Logs:** pino JSON → Collector → Loki with `trace_id` / `span_id` injected by the active OpenTelemetry context.

### Drill-down wiring
Prometheus exemplar → Tempo trace (`exemplarTraceIdDestinations`) → Loki logs (`tracesToLogsV2` with `filterByTraceID`) — and back from logs to trace via `derivedFields`. Single click: dashboard panel → exemplar dot → Tempo trace → "View logs" → Loki, all scoped to one `trace_id`.

### Files
Stack config: [observability/collector/config.yaml](observability/collector/config.yaml), [observability/prometheus/prometheus.yml](observability/prometheus/prometheus.yml), [observability/tempo/tempo.yaml](observability/tempo/tempo.yaml), [observability/loki/loki-config.yaml](observability/loki/loki-config.yaml), [observability/grafana/provisioning/](observability/grafana/provisioning/), [observability/grafana/dashboards/slo-overview.json](observability/grafana/dashboards/slo-overview.json), [docs/SLA.md](docs/SLA.md). App-side: `*/src/observability/{tracing,logger,metrics,tracer}.ts` (tracing.ts is imported *first* in `main.ts` so auto-instrumentation patches `http`/`pg` before they're loaded).

Six containers + ~1 GB RAM is overkill for a 3-seat demo — it's on the page to demonstrate the *production shape*, not because it's needed to run the service. Skipping the profile leaves the SDK as a no-op when there's no Collector to talk to.

### Dashboard preview without running the stack

A reviewer who would rather not spin up Grafana + Tempo + Loki + Prometheus + Collector still sees what the SLO dashboard contains: [observability/grafana/dashboards/PREVIEW.md](observability/grafana/dashboards/PREVIEW.md) lists every panel with the PromQL query behind it and a one-line note on what it shows (including the `duplicate` / `noop_stale` payment-outcome breakdown and the burn-rate panels). Captured PNGs live under [observability/grafana/dashboards/screenshots/](observability/grafana/dashboards/screenshots/) (recipe to regenerate them in the README there). The text preview is the source-of-truth pairing with [slo-overview.json](observability/grafana/dashboards/slo-overview.json); the PNGs are best-effort snapshots.
