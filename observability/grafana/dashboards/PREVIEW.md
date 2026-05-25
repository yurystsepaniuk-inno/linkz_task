## Linkz — SLO Overview (dashboard preview)

This is a stand-in for the live Grafana dashboard so a reviewer who does not
want to bring up the ~1 GB observability stack still sees what the panels
contain. The source of truth is [slo-overview.json](slo-overview.json) — this
file is regenerated from there by hand whenever a panel changes.

When the stack is running locally, open it at
http://localhost:3030/d/linkz-slo-overview after `docker compose --profile
observability up`.

Captured screenshots (when populated by a maintainer) live in
[screenshots/](screenshots/). The file there is the recipe to generate them.

---

### Row 1 — SLI: Reservation Availability

| Panel | Query | Notes |
| --- | --- | --- |
| Reservation success rate (rolling 30m) — target 95% | `sum(rate(reservations_total{outcome=~"confirmed\|conflict"}[30m])) / sum(rate(reservations_total[30m]))` | `conflict` (409 already-booked) is a valid business outcome, not an error — counted as success. |
| Reservation outcomes over time | `sum by (outcome) (rate(reservations_total[1m]))` | Stacked: confirmed / conflict / failed / expired. |

### Row 2 — SLI: Reservation Latency (p95)

| Panel | Query | Notes |
| --- | --- | --- |
| POST /api/reservations p95 — target < 500 ms | `histogram_quantile(0.95, sum by (le) (rate(reservation_request_duration_seconds_bucket[5m])))` | p50 overlaid as reference. |

### Row 3 — SLI: Payment Success

| Panel | Query | Notes |
| --- | --- | --- |
| Payment success rate (30m) | `sum(rate(payment_outcomes_total{outcome="succeeded"}[30m])) / sum(rate(payment_outcomes_total{outcome=~"succeeded\|failed"}[30m]))` | Denominator excludes `duplicate` and `noop_stale` so retry noise can't move the SLI. |
| Payment outcomes (incl. duplicates) | `sum by (outcome) (rate(payment_outcomes_total[1m]))` | Breakdown: succeeded / failed / duplicate / **noop_stale** (orphan — reconciliation cron will refund). |

### Row 4 — SLI: Webhook Delivery

| Panel | Query | Notes |
| --- | --- | --- |
| Webhook delivery success (terminal status, 30m) | `sum(rate(webhook_delivery_final_total{outcome="delivered"}[30m])) / sum(rate(webhook_delivery_final_total[30m]))` | Excludes in-flight retries — only terminal `delivered` vs `failed`. |
| Webhook attempts vs. terminal outcomes | `sum by (outcome) (rate(webhook_delivery_attempts_total[1m]))` + `sum by (outcome) (rate(webhook_delivery_final_total[1m]))` | Attempt-level (`sent`/`failed`) on top of terminal-level (`delivered`/`failed`) makes retry storms visible. |

### Row 5 — Error budget (95% SLO over 30 days)

| Panel | Query | Notes |
| --- | --- | --- |
| Reservation availability — error-budget remaining (30d) | `clamp_min(1 - ((sum(rate(reservations_total{outcome="failed"}[30d])) / sum(rate(reservations_total[30d]))) / 0.05), 0)` | 1.0 = full budget; 0 = exhausted. |
| Error-budget burn — 1h burn rate (alert when > 1) | `(sum(rate(reservations_total{outcome="failed"}[1h])) / sum(rate(reservations_total[1h]))) / 0.05` | 6h burn overlaid. Multi-window burn-rate alerting, Google SRE-style. |

### Row 6 — Operational counters (not SLIs)

| Panel | Query | Notes |
| --- | --- | --- |
| Cron sweeps & reconciliation | `seat_expiry_swept_total`, `checkout_sessions_expired_total`, `reconciliation_refunds_total{outcome=…}` per 5m | Visible "safety-net activity" — non-zero means the happy path missed something. |
| Security: webhook signature rejections | `sum(rate(webhook_signature_rejected_total[5m]))` | **Alert if > 0** for any window — every hit is a forged-payload attempt. |

---

### Drill-down wiring (visible in the live dashboard only)

- Prometheus exemplars on the latency histogram link out to Tempo traces
  (`exemplarTraceIdDestinations`).
- Tempo traces link to Loki via `tracesToLogsV2 { filterByTraceID: true }` —
  one click takes you from a slow span to the request's structured logs.
- Loki log lines link back to traces through Tempo `derivedFields` on the
  `trace_id` JSON field that pino injects.

Net effect: a single click path from a dashboard panel → exemplar dot →
Tempo trace → "View logs" → Loki, all scoped to one `trace_id`.
