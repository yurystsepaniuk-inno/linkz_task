# Seat Reservation Platform

A minimal seat reservation platform consisting of four services. The scope is deliberately small (3 seats, 2 demo users) so the README can focus on the *engineering decisions* — what was built, what was deferred, and why.


The Gherkin acceptance criteria can be found in [docs/acceptance-criteria/](docs/acceptance-criteria/). Scenarios that were explicitly excluded from this implementation (such as idempotency keys, refund compensation, and DLQ handling) are detailed in [docs/scope-not-implemented/](docs/scope-not-implemented/). While these robust features are highly valuable for a production system, they fell outside what was realistic to implement within the 2-hour time constraint of this assignment. However, I’ve included them in the documentation to demonstrate how the system could be scaled with more time.

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


## Quick Start

### Prerequisites
- Node 20+
- Docker & Docker Compose

### 1. Start Postgres

```bash
docker compose up -d
```

### 2. Configure environment

Copy each `.env.example` to `.env` and adjust if needed:

```bash
cp reservation-api/.env.example reservation-api/.env
cp payment-api/.env.example     payment-api/.env
cp reservation-web/.env.example reservation-web/.env
cp payment-web/.env.example     payment-web/.env
```

> `WEBHOOK_SECRET` must be **identical** in `reservation-api/.env` and `payment-api/.env`.
> `PAYMENT_API_KEY` (reservation-api) must equal `API_KEY` (payment-api).

### 3. Migrate and seed

```bash
cd reservation-api
npm install
npm run migrate
cd ..
```

This applies the schema and seeds two demo users:
- `alice@example.com` / `password123`
- `bob@example.com`   / `password123`

### 4. Start all services

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
2. Login with `alice@example.com` / `password123`
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

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `POST` | `/api/auth/login` | — | `{email, password}` | `{token}` (JWT, 90d) / `401` |
| `GET`  | `/api/seats` | JWT | — | `[{id, status}]` |
| `POST` | `/api/reservations` | JWT | `{seatId}` | `201 {checkoutUrl}` / `409 SEAT_ALREADY_OCCUPIED` / `502` |
| `POST` | `/api/webhooks/payment` | HMAC `x-signature` | `{event, sessionId, seatId, userId}` | `{received:true}` / `401` / `400` |

### payment-api (`:3003`)

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `POST` | `/api/checkout/sessions` | `x-api-key` | `{seatId, userId, amount}` | `{sessionId, checkoutUrl}` / `401` |
| `GET`  | `/api/checkout/sessions/:id` | — | — | `{seatId, amount}` / `404` |
| `POST` | `/api/checkout/sessions/:id/pay` | — | `{cardNumber}` | `{status:"success"\|"failed"}` / `400` / `404` |

---

## Database Schema

reservation-api owns a single PostgreSQL database with three tables.

```
users
├── id            UUID  PK
├── email         TEXT  UNIQUE NOT NULL
└── password_hash TEXT  NOT NULL

seats
├── id     TEXT  PK
└── status TEXT  NOT NULL  CHECK (AVAILABLE | PENDING_PAYMENT | CONFIRMED)

reservations
├── id         UUID        PK
├── seat_id    TEXT        FK → seats.id   NOT NULL
├── user_id    UUID        FK → users.id   NOT NULL
├── session_id TEXT        (payment-provider session; set after checkout session is created)
├── status     TEXT        NOT NULL  CHECK (PENDING_PAYMENT | CONFIRMED | FAILED | EXPIRED)
├── created_at TIMESTAMPTZ NOT NULL  DEFAULT NOW()
└── locked_at  TIMESTAMPTZ (set at reservation time; swept by cron after 5 min)
```

**Indexes on `reservations`:**

| Index | Columns | Purpose |
|---|---|---|
| `reservations_sweep_idx` | `(status, locked_at)` WHERE `PENDING_PAYMENT` | cron expiry sweep |
| `reservations_user_idx` | `user_id` | lookup by user |
| `reservations_session_idx` | `session_id` WHERE NOT NULL | webhook matching |

---

## Environment Variables

### reservation-api
| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `localhost` / `5432` / `app` / `app` / `reservations` | Postgres connection |
| `JWT_SECRET` | — | JWT signing key |
| `WEBHOOK_SECRET` | — | Shared with payment-api for HMAC |
| `PAYMENT_API_URL` | `http://localhost:3003` | Outbound calls to create checkout sessions |
| `PAYMENT_API_KEY` | — | Must match `API_KEY` in payment-api; sent as `x-api-key` when creating checkout sessions |
| `RESERVATION_AMOUNT` | `10.00` | Per-seat price sent to payment-api |
| `PORT` | `3000` | HTTP port |
| `CORS_ORIGIN` | `http://localhost:3001` | reservation-web origin |

### payment-api
| Variable | Default | Purpose |
|---|---|---|
| `WEBHOOK_SECRET` | — | Must match reservation-api |
| `API_KEY` | — | Must match `PAYMENT_API_KEY` in reservation-api; guards `POST /api/checkout/sessions` |
| `RESERVATION_API_URL` | `http://localhost:3000` | Webhook delivery target |
| `PUBLIC_BASE_URL` | `http://localhost:3002` | Used to construct `checkoutUrl` |
| `PORT` | `3003` | HTTP port |
| `CORS_ORIGIN` | `http://localhost:3002` | payment-web origin |

### reservation-web
| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | reservation-api base URL |

### payment-web
| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3003` | payment-api base URL |
| `VITE_RESERVATION_WEB_URL` | `http://localhost:3001` | Where the "back" button on the result page points |

---

## Running Tests

```bash
# reservation-api — 14 tests, 5 suites (Jest)
cd reservation-api && npm test
```

```bash
# payment-api — 18 tests, 3 suites (Jest)
cd payment-api && npm test
```

```bash
# reservation-web — 11 tests, 2 suites (Vitest + RTL)
cd reservation-web && npm test
```

```bash
# payment-web — 8 tests, 2 suites (Vitest + RTL)
cd payment-web && npm test
```

Coverage of service-layer branches is 75–100% across both APIs. Untested files are NestJS framework wiring (controllers, modules, DTOs) — those are intentionally left to e2e/integration tests rather than unit tests.

---

## Architecture Decisions

This section documents the non-obvious choices and the trade-offs behind them.

### Four services instead of a monolith
**Why:** to show service boundaries — auth/seat state, hosted checkout UI, and payment processing each have different security postures, deployment cadences, and scaling profiles in a real system.
**Trade-off:** four `npm install`s, four ports, a webhook hop, CORS configuration on each API. For 3 seats this is obviously over-engineered. For a real platform it isn't.

### Separate `reservations` table; `seats` holds only availability state
**Why:** a seat is a static physical entity; a reservation is a transient event with a lifecycle (pending → confirmed / failed / expired). Storing `session_id`, `locked_at`, and `user_id` directly on `seats` mixed two concerns in one row and made the columns mean different things depending on `status`. Moving them to a dedicated `reservations` table gives a full audit trail, keeps `seats` as a clean availability cache, and places payment-provider correlation (`session_id`) where it belongs — on the payment transaction, not the seat.
**Trade-off:** queries that need both seat status and reservation detail now touch two tables. For this scope the added clarity is worth it.

### Raw `pg.Pool`, no ORM
**Why:** the data model is three tables (`users`, `seats`, `reservations`) and a `SELECT ... FOR UPDATE`. An ORM would obscure the lock semantics, which is the *one* thing here that has to be correct.
**Trade-off:** writing SQL by hand and managing the migration script myself. Acceptable at this size.

### Pessimistic locking (`SELECT FOR UPDATE`) for seat reservation
**Why:** seat reservation is a low-write, low-contention, very-high-consequence operation. The row is locked for milliseconds. The cost of a missed serialization is double-booking.
**Trade-off considered:** optimistic concurrency with a version column would also work and scale better, but it requires retry logic on the client and produces nicer Postgres metrics — overkill for 3 seats.

### Synchronous HMAC-signed webhook (no queue)
**Why:** simplest correct primitive for service-to-service event delivery: HMAC-SHA256 over the raw body, `timingSafeEqual` comparison.
**Trade-off:** if reservation-api is down when payment-api fires the webhook, the event is lost. The 5-minute lock-expiry cron means the user simply can't book that seat for 5 minutes — they aren't permanently stuck. A real platform would put a queue (SQS, RabbitMQ, Outbox pattern) between payment and reservation; here that's documented as out-of-scope.

### JWT in `localStorage`
**Why:** simplest auth that satisfies the 90-day session requirement without a session store. No CSRF concerns (no cookie). Compact across all four services.
**Trade-off:** vulnerable to token theft via XSS. The right production answer is an httpOnly + Secure + SameSite cookie with a server-side session and CSRF protection on state-changing endpoints.

### In-memory session store in payment-api
**Why:** payment sessions are short-lived (minutes), and the brief specifies a "mock payment provider." Keeping payment-api isolated mimics a real third-party checkout flow (like Stripe Checkout): the reservation service never exposes or handles sensitive payment credentials — a deliberate data-security boundary.
**Session lifecycle:** each session has a 30-minute TTL enforced at read time (`SessionsStore.get()` evicts and returns `undefined` for expired entries). Sessions are also single-use: `pay()` rejects any session whose status is no longer `PENDING`, preventing replay after a `PAID` or `FAILED` outcome.
**Trade-off:** sessions live only in memory, so they evaporate on restart and payment-api cannot scale horizontally — a second instance wouldn't share session state. Acceptable for a mock; a real provider persists sessions in its own datastore.

### Mock payment-api as a Stripe Checkout stand-in
**Why:** the integration contract that payment-api implements — create a session, redirect the user to a hosted payment page, receive an HMAC-signed webhook on completion — is structurally identical to [Stripe Checkout](https://stripe.com/docs/checkout). reservation-api creates a session (`POST /api/checkout/sessions`), hands the user a `checkoutUrl`, and waits for a signed webhook; it never touches a card number or payment credential directly. This boundary is the same whether the provider is this mock or Stripe.
**Production path:** replace payment-api with Stripe Checkout. The `checkoutUrl` becomes a Stripe-hosted URL, the webhook becomes a `Stripe-Signature`-verified event, and the `PAYMENT_API_URL` / `PAYMENT_API_KEY` env vars are replaced with Stripe's `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. No structural changes to reservation-api are required — only the env configuration and the outbound HTTP call.
**Trade-off:** the shared `x-api-key` used to authenticate reservation-api against payment-api is intentionally lightweight and well-suited to local development. In production with a real provider like Stripe, service-to-service authentication is handled by the provider's own credential scheme, so the `x-api-key` pattern is replaced automatically when Stripe is adopted.

### One Postgres, both APIs… but only reservation-api touches it
**Why:** payment-api has no durable state at this scope (see above). When durability is added, payment-api would own its *own* Postgres (separate schema or instance). Database-per-service is the correct boundary even if we cheat in the demo.

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

This is deliberately an **on-prem / locally-runnable** deployment rather than a cloud deployment — and that is itself an engineering decision, not an omission.

**Why on-prem for this assessment:**
- The deliverable is verified by a human reviewer, not a CI pipeline. A cloud deployment would force the reviewer to either trust a live URL (which can drift, expire, or cost money to keep up) or provision their own cloud credentials before they can see anything run.
- Running everything locally means the reviewer clones the repo, runs the documented commands, and observes the *real* system end-to-end in minutes — including database state, logs, and webhook traffic.
- No cloud accounts, secrets managers, or external dependencies. The system is fully reproducible on any machine with Node 20+ and Docker, so behavior on the reviewer's machine is identical to behavior on mine.

**What is containerized and what isn't:**
- `docker compose up -d` runs Postgres — the one component that genuinely benefits from containerization (consistent version, isolated data volume, zero local install).
- The four Node services run directly via `npm run`. This is intentional for a review context: the reviewer can read each service's logs in its own terminal, restart one service in isolation, and set breakpoints while inspecting behavior. A `docker compose` that hides all four behind one process would make the system *easier to start* but *harder to inspect* — the wrong trade-off when the goal is verification.

**What a real production deployment would change:**
- Each service built into its own image and orchestrated (Kubernetes / ECS), with health and readiness probes.
- Database-per-service: payment-api would own its own Postgres once it has durable state (see [Architecture Decisions](#architecture-decisions)).
- Secrets pulled from a secret manager (AWS Secrets Manager, Vault), not `.env` files.
- TLS termination behind a reverse proxy; the service-to-service webhook hop over HTTPS.
- The two web apps built to static assets and served from a CDN, not `vite dev`.
- Centralized logging and metrics instead of per-terminal `console` output.

The trade-off is explicit: this setup is optimized for **reviewer verifiability**, not for production operation. The production path is documented above so the gap is a deliberate, visible decision.

---

## Security Considerations

### What is protected

- **Passwords:** bcrypt (cost factor 10) at rest. Never logged.
- **JWT:** signed with `JWT_SECRET`, `expiresIn: '90d'`, validated server-side on every authenticated request.
- **SQL injection:** all queries use parameterized statements (`$1`, `$2`...). No string concatenation against user input.
- **Webhook authenticity:** HMAC-SHA256 of the raw request body against `WEBHOOK_SECRET`, compared with `timingSafeEqual` to prevent timing attacks. Length-mismatched signatures are rejected before comparison.
- **CORS:** each API has an explicit origin allowlist. Not `*`.
- **Input validation:** `class-validator` on all DTOs (NestJS `ValidationPipe` runs globally). Card number format validated via regex before any business logic.
- **Seat double-booking:** prevented by `SELECT ... FOR UPDATE` inside a transaction. The reservation row is locked between SELECT and UPDATE, so two concurrent requests serialize.
- **Service-to-service authentication:** `POST /api/checkout/sessions` on payment-api requires a shared `x-api-key` header. Only reservation-api, which holds `PAYMENT_API_KEY`, can create checkout sessions. This prevents an external caller from crafting a session for an arbitrary `seatId`/`userId` and triggering a validly-signed webhook that would confirm or release another user's active reservation. The key never reaches the browser: it lives in reservation-api's server environment and is attached to an outbound server-side fetch call; the browser only ever receives the resulting `checkoutUrl`.
- **Stale-payment webhook isolation:** the webhook UPDATE is anchored to `AND session_id = $sessionId`. A late payment event from a previous checkout session cannot confirm or cancel a newer reservation of the same seat — even for the same user — because each reservation attempt gets a unique `session_id` stored on its `reservations` row and included in the webhook payload. A stale event carries the old `sessionId`, which no longer matches any active reservation row.
- **Payment session single-use:** `POST /api/checkout/sessions/:id/pay` checks that the session status is still `PENDING` before processing. A session that is already `PAID` or `FAILED` is rejected with `400 alreadyProcessed`. This prevents an attacker from replaying an old session (e.g. calling `pay()` a second time with a different card) to fire a second validly-signed webhook — which could corrupt seat state if the same user had re-booked the same seat in the interim.
- **Payment session TTL:** checkout sessions expire after 30 minutes. `get()` evicts and returns `undefined` for expired sessions, so both the hosted checkout page and `pay()` return `404` on stale links. This bounds the window in which a session-replay is possible even if the single-use guard were absent.


### Threat model notes

- The **demo card numbers** (`4000` = success, `5000` = failure) are a deliberate mock contract — there is no real card data anywhere in the system.
- The **webhook secret is symmetric**, which is fine when both ends are operated by the same team. A real third-party payment provider would use asymmetric signatures (RSA/Ed25519) so the secret is never shared.
- The **JWT secret** is loaded from env. In production this belongs in a secret manager (AWS Secrets Manager, Vault, Doppler), not a `.env` file.

---

## Failure Modes & Reliability

Concrete failure scenarios and what the system does in each case.

| Scenario | Behavior | Notes |
|---|---|---|
| **Two users click Book on the same seat at the same instant** | `SELECT ... FOR UPDATE` serializes the requests. One gets `201 + checkoutUrl`. The other gets `409 SEAT_ALREADY_OCCUPIED`. No payment session is created for the loser. | Verified by unit test + can be reproduced with `curl` in parallel. |
| **User starts payment and closes the tab** | Seat sits in `PENDING_PAYMENT`. Cron worker releases it after 5 minutes (`locked_at < NOW() - 5min`). | The user can refresh and try again, or someone else can take the seat after the lock expires. |
| **Webhook from payment-api never arrives** | reservation-api never sees the success/failure event. Cron releases the seat after 5 minutes. | The user has paid (or failed to pay) at payment-api but reservation-api doesn't know — see "known reconciliation gap" below. |
| **Webhook arrives with invalid signature** | reservation-api rejects with `401 Unauthorized`. Seat unchanged. | Verified by unit test. In production this should also trigger an alert. |
| **Webhook arrives for a seat no longer in `PENDING_PAYMENT`** | The reservations UPDATE includes `AND status = 'PENDING_PAYMENT' AND session_id = $sessionId`. Rowcount is 0; the webhook is effectively a no-op. Response is still `{received:true}`. | This makes the webhook idempotent for the happy path — duplicate deliveries don't double-confirm. |
| **Duplicate webhook for an already-confirmed seat** | Same as above — the reservations UPDATE matches no rows; the seats UPDATE is skipped. | A more rigorous solution would track `(webhook_id, status)` so duplicates are observable, not just absorbed. |
| **Stale webhook from User A arrives while seat is `PENDING_PAYMENT` for User B** | The `AND session_id = $sessionId` clause prevents the match on the reservations table. User B's reservation is untouched. Response is still `{received:true}`. | Each webhook is anchored to the unique checkout session ID stored on the `reservations` row, so a late event carrying a stale `sessionId` matches no active reservation regardless of who currently holds the seat. |
| **Late webhook for a seat that timed out and is now `CONFIRMED` by someone else** | Webhook UPDATE matches no rows on both `status` and `session_id`; the second user keeps the seat; the first user has paid at payment-api with no corresponding reservation. **This is the known reconciliation gap.** See below. | |
| **User calls `pay()` a second time on an already-PAID or FAILED session** | payment-api rejects with `400 alreadyProcessed` before any webhook is fired. No second webhook is ever sent to reservation-api. | Without this guard, a same-user re-booking of the same seat followed by replaying the old session would match the UPDATE SQL and corrupt seat state. Verified by unit tests. |
| **User accesses checkout page or calls `pay()` on a session older than 30 minutes** | `SessionsStore.get()` evicts the session and returns `undefined`; the response is `404 Session not found`. | Bounds the session-replay window even if an application-level guard were absent. |

### The reconciliation gap (known limitation)

If a webhook is delayed past the 5-minute expiry **and** another user takes the seat in the interim, the original user's payment at payment-api has no matching reservation. Today this user would need to be refunded manually.

The fully-engineered solution requires:
1. ~~A `payments` table~~ — the `reservations` table already records who attempted a reservation and with which `session_id` before payment is initiated. An EXPIRED reservation whose `session_id` matches a late incoming webhook can be identified.
2. On late-webhook arrival, detect that the matched reservation is in `EXPIRED` state (not `PENDING_PAYMENT`) and trigger an automated refund via the payment provider.
3. A "dead-letter" / human-review queue for refunds that themselves fail.

This is explicitly out of scope for the assessment — the full scenario is captured in [docs/scope-not-implemented/booking_system.feature](docs/scope-not-implemented/booking_system.feature) under "Execute compensation refund."
