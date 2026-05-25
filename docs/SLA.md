# Linkz — Service Level Agreement

**Effective:** 2026-05-25
**Owner:** Linkz Reliability
**Review cadence:** quarterly, or whenever a budget is exhausted

This document describes the customer-facing reliability commitments Linkz
makes for the seat-reservation platform, derived from the SLO targets in the
internal SLO dashboard (`observability/grafana/dashboards/slo-overview.json`).
SLA targets are intentionally set *at or below* the corresponding SLOs so
that the engineering team always trips an internal alarm before a customer
notices a breach.

---

## 1. Scope

The SLA covers the production transaction path:

| Surface | Endpoint(s) |
|---|---|
| **Reservation creation** | `POST /api/reservations` (reservation-api) |
| **Checkout** | `GET /api/checkout/sessions/:id`, `POST /api/checkout/sessions/:id/pay` (payment-api) |
| **Webhook delivery** | `POST /api/webhooks/payment` (reservation-api, inbound from payment-api) |

Out of scope: admin tooling, the reconciliation cron (it is itself the
recovery mechanism — see §5), audit-read endpoints used by support
operations, and the buyer-UX polling endpoint
`GET /api/checkout/sessions/:id/delivery-status` (a best-effort read for
clearing the "still syncing" banner — its commitment is the underlying
webhook-delivery SLI in §2.4, not the poll itself, which is
per-IP rate-limited at 120 req/min).

---

## 2. SLIs (Service Level Indicators)

The four numbers we measure. Each is computed from a Prometheus counter
exposed by the application and visible on the *Linkz — SLO Overview*
Grafana dashboard.

### 2.1 Reservation availability

> *"What fraction of reservation requests return a sensible business
> outcome — confirmation or a 409 'seat taken' — rather than a server
> failure?"*

```promql
sum(rate(reservations_total{outcome=~"confirmed|conflict"}[30m]))
/
sum(rate(reservations_total[30m]))
```

Note that **HTTP 409 is a successful outcome**: the seat genuinely is
taken, the API correctly told the user, no engineer needs to wake up.
Only `outcome="failed"` (DB error, payment-api unreachable, etc.) counts
against the budget.

### 2.2 Reservation latency

> *"How fast does `POST /api/reservations` return for the slowest 5% of
> users?"*

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(reservation_request_duration_seconds_bucket[5m]))
)
```

### 2.3 Payment success rate

> *"Of payment attempts whose outcome we've observed via webhook, what
> fraction succeeded?"*

```promql
sum(rate(payment_outcomes_total{outcome="succeeded"}[30m]))
/
sum(rate(payment_outcomes_total{outcome=~"succeeded|failed"}[30m]))
```

`duplicate` and `noop` are excluded from both numerator and denominator
— they describe webhook delivery, not payment outcomes. A `duplicate`
spike instead surfaces in §2.4.

### 2.4 Webhook delivery success

> *"Of webhooks payment-api committed to delivering, what fraction made
> it (eventually, including retries) to a 2xx response from
> reservation-api?"*

```promql
sum(rate(webhook_delivery_final_total{outcome="delivered"}[30m]))
/
sum(rate(webhook_delivery_final_total[30m]))
```

A delivery is counted *once*, when it reaches a terminal status. The
retry attempts in between contribute to `webhook_delivery_attempts_total`
and are visible as the gap between the two series in the SLO dashboard
— a widening gap means we're spending retries, not yet failing.

---

## 3. SLO targets

All SLIs are sized to a **5% error budget over a rolling 30-day window**,
yielding the same **95% SLO** across every signal. We pick a single
target rather than per-SLI targets so on-call doesn't have to remember
four numbers; the burn-rate alerts (see §6) use the same 95% / 5% split.

| SLI | SLO | Error budget (30d) |
|---|---|---|
| Reservation availability | ≥ **95%** of `confirmed+conflict` over total | 5% (= ~36 hours of complete outage, or ~1.5 days of 10% failure) |
| Reservation latency p95 | ≤ **500 ms** | 5% of requests may exceed 500 ms |
| Payment success rate | ≥ **95%** | 5% (excluding card-declined which is a user outcome, not a system error) |
| Webhook delivery | ≥ **95%** of `delivered` over `delivered+failed` | 5% (the reconciliation cron — §5 — covers the residual) |

---

## 4. SLA commitments

SLAs are the customer-facing version of the SLOs above. We commit to the
target one notch below the SLO so internal alerting fires first.

| Commitment | Number |
|---|---|
| Reservation availability | **99% monthly** (≈ 7.2 hours of degraded service per month) |
| Reservation latency | **p95 ≤ 1 s** at the public load-balancer |
| Payment processing | A payment attempt receives a response within **5 s** |
| Webhook delivery (eventual) | A payment outcome is reflected in the buyer's reservation within **30 minutes** — webhook fast-path; reconciliation cron is the slow-path safety net (§5) |

### Exclusions

- Scheduled maintenance windows announced ≥ 48 h in advance.
- Customer-side network issues, ISP outages, browser bugs.
- Card declines (`5000` test cards and equivalent) — these are a
  *successful* payment outcome from a platform standpoint.
- Force-majeure events affecting the cloud provider.
- `429 Too Many Requests` on `GET /api/checkout/sessions/:id/delivery-status`
  when a single IP exceeds 120 requests/minute. Buyer-facing clients use
  exponential backoff (1.5 → 10 s, capped) and stay well under the cap;
  exceeding it indicates a misbehaving client, not a platform incident.

### Remedies

This document is the engineering-side SLA; commercial credits / refunds
are described in the customer's MSA and reference the metrics here.

---

## 5. How burning the budget changes our behavior

The error budget is the *only* thing that decides whether we ship
features or invest in reliability. The policy is mechanical, not
political:

| Budget remaining (30d) | What happens |
|---|---|
| **> 50%** | Normal cadence: feature work proceeds, on-call is reactive only. |
| **25–50%** | Engineering review of every PR that touches the transaction path; reliability items get priority in the next sprint. |
| **< 25%** | **Feature freeze on the affected surface.** All non-bugfix work pauses until the budget recovers. The reconciliation cron stays running (it *is* the recovery mechanism). |
| **0%** | Public status-page post; engineering investigation runs as an incident; SLA commitment in §4 is at risk. |

The Grafana dashboard's *Error budget remaining (30d)* gauge is the
single source of truth — it's the same number used in the policy above.

---

## 6. Alerting policy (burn-rate, multi-window)

We use the SRE-handbook multi-window burn-rate alerts rather than raw
thresholds, because a raw threshold either pages on every blip or stays
silent through a real degradation. The three-window approach catches
both:

| Severity | Condition |
|---|---|
| **Page (P1)** | 1-hour burn rate **> 14.4** AND 5-minute burn rate **> 14.4** (would consume the entire 30-day budget in ≤ 2 hours) |
| **Ticket (P2)** | 6-hour burn rate **> 6** AND 30-minute burn rate **> 6** (would consume the budget in ≤ 5 days) |
| **Trend (P3)** | 24-hour burn rate **> 1** (budget on track to be consumed in less than 30 days) |

The 1h and 6h burn-rate panels are on the SLO dashboard. P1/P2 alert
rules live alongside the dashboard JSON — provisioning them is left as a
follow-up since alertmanager isn't part of the local-dev profile.

---

## 7. Measurement window & data retention

- All SLIs are computed over a **rolling 30-day window**, refreshed
  every Prometheus scrape interval (15 s).
- Histogram buckets retain p50/p95/p99 fidelity for that window.
- Loki log retention: 7 days locally; production target 30 days.
- Tempo trace retention: 24 hours locally; production target 7 days.
- The audit ledger in `payment_transactions` is permanent — it is the
  legal record of every transaction and survives any retention policy
  applied to traces/logs/metrics.

---

## 8. Why this stack, briefly

| Choice | Why |
|---|---|
| OpenTelemetry, not vendor SDKs | The Collector is the only thing that knows about Tempo/Prometheus/Loki — the apps don't. Switching to a managed APM later is a one-file edit. |
| 95% SLO, 5% budget | Per the client's instruction; deliberately *not* "as many nines as we can squeeze". Five nines is overkill for a seat-reservation flow and the budget would never get spent on learning. |
| Single SLO across SLIs | One number for on-call to remember. Four different SLOs would require an SLO-of-SLOs explanation in this document, which is a smell. |
| Single trace per reservation | The trace spans reservation-api → payment-api → webhook return trip via OTel context propagation. Drilling from a latency exemplar into the trace shows the whole user-visible request, not just one service's slice. |
| 30-day rolling window | Long enough to smooth daily seasonal patterns, short enough that a recovered service stops "owing" its prior failures within a month. |
