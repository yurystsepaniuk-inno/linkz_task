# Seat Reservation Platform

A minimal seat reservation platform consisting of four services. The scope is deliberately small (3 seats, 2 demo users) so the README can focus on the *engineering decisions* — what was built, what was deferred, and why.

## Contents


1. [Quick Start](#quick-start)
2. [End-to-End Flow](#end-to-end-flow)
3. [API Reference](#api-reference)
4. [Environment Variables](#environment-variables)
5. [Running Tests](#running-tests)
6. [Architecture Decisions](#architecture-decisions)
7. [Deployment](#deployment)
8. [Security Considerations](#security-considerations)
9. [Failure Modes & Reliability](#failure-modes--reliability)


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

### 3. Migrate and seed

```bash
cd reservation-api
npm install
npm run migrate
```

This applies the schema and seeds two demo users:
- `alice@example.com` / `password123`
- `bob@example.com`   / `password123`

### 4. Start all services

In four terminals:

```bash
# reservation-api (:3000)
cd reservation-api && npm run start:dev

# payment-api (:3003)
cd payment-api && npm install && npm run start:dev

# reservation-web (:3001)
cd reservation-web && npm install && npm run dev

# payment-web (:3002)
cd payment-web && npm install && npm run dev
```

---

## End-to-End Flow

1. Open <http://localhost:3001>
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
| `POST` | `/api/webhooks/payment` | HMAC `x-signature` | `{event, seatId}` | `{received:true}` / `401` / `400` |

### payment-api (`:3003`)

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/checkout/sessions` | `{seatId, amount}` | `{sessionId, checkoutUrl}` |
| `GET`  | `/api/checkout/sessions/:id` | — | `{seatId, amount}` / `404` |
| `POST` | `/api/checkout/sessions/:id/pay` | `{cardNumber}` | `{status:"success"\|"failed"}` / `400` / `404` |

Gherkin acceptance criteria are in [docs/acceptance-criteria/](docs/acceptance-criteria/). Scenarios that were considered and explicitly excluded (idempotency keys, refund compensation, DLQ, etc.) are in [docs/scope-not-implemented/](docs/scope-not-implemented/). If there is more time, I would love to implement all scenarious, so that is why it is shared with you under docs.

---

## Environment Variables

### reservation-api
| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `localhost` / `5432` / `app` / `app` / `reservations` | Postgres connection |
| `JWT_SECRET` | — | JWT signing key |
| `WEBHOOK_SECRET` | — | Shared with payment-api for HMAC |
| `PAYMENT_API_URL` | `http://localhost:3003` | Outbound calls to create checkout sessions |
| `RESERVATION_AMOUNT` | `10.00` | Per-seat price sent to payment-api |
| `PORT` | `3000` | HTTP port |
| `CORS_ORIGIN` | `http://localhost:3001` | reservation-web origin |

### payment-api
| Variable | Default | Purpose |
|---|---|---|
| `WEBHOOK_SECRET` | — | Must match reservation-api |
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
# 40 tests total across the four services
cd reservation-api && npm test    # 14 tests, 5 suites (Jest)
cd payment-api     && npm test    #  7 tests, 1 suite  (Jest)
cd reservation-web && npm test    # 11 tests, 2 suites (Vitest + RTL)
cd payment-web     && npm test    #  8 tests, 2 suites (Vitest + RTL)
```

Coverage of service-layer branches is 75–100% across both APIs. Untested files are NestJS framework wiring (controllers, modules, DTOs) — those are intentionally left to e2e/integration tests rather than unit tests.

---

## Architecture Decisions

This section documents the non-obvious choices and the trade-offs behind them.

### Four services instead of a monolith
**Why:** to show service boundaries — auth/seat state, hosted checkout UI, and payment processing each have different security postures, deployment cadences, and scaling profiles in a real system.
**Trade-off:** four `npm install`s, four ports, a webhook hop, CORS configuration on each API. For 3 seats this is obviously over-engineered. For a real platform it isn't.

### Raw `pg.Pool`, no ORM
**Why:** the data model is two tables and a `SELECT ... FOR UPDATE`. An ORM would obscure the lock semantics, which is the *one* thing here that has to be correct.
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
**Trade-off:** sessions live only in memory, so they evaporate on restart and payment-api cannot scale horizontally — a second instance wouldn't share session state. Acceptable for a mock; a real provider persists sessions in its own datastore.

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
| **Webhook arrives for a seat no longer in `PENDING_PAYMENT`** | The UPDATE clause includes `AND status = 'PENDING_PAYMENT'`. Rowcount is 0; the webhook is effectively a no-op. Response is still `{received:true}`. | This makes the webhook **idempotent** for the happy path — duplicate deliveries don't double-confirm. |
| **Duplicate webhook for an already-confirmed seat** | Same as above — UPDATE matches no rows. | A more rigorous solution would track `(webhook_id, status)` so duplicates are observable, not just absorbed. |
| **Late webhook for a seat that timed out and is now booked by someone else** | Webhook UPDATE matches no rows; the second user keeps the seat; the first user has paid at payment-api with no corresponding reservation. **This is the known reconciliation gap.** See below. | |

### The reconciliation gap (known limitation)

If a webhook is delayed past the 5-minute expiry **and** another user takes the seat in the interim, the original user's payment at payment-api has no matching reservation. Today this user would need to be refunded manually.

The fully-engineered solution requires:
1. A `payments` table that records the payment intent at reservation time, before payment is initiated.
2. On late-webhook arrival, detect the orphaned payment and trigger an automated refund via the payment provider.
3. A "dead-letter" / human-review queue for refunds that themselves fail.

This is explicitly out of scope for the assessment — the full scenario is captured in [docs/scope-not-implemented/booking_system.feature](docs/scope-not-implemented/booking_system.feature) under "Execute compensation refund."
