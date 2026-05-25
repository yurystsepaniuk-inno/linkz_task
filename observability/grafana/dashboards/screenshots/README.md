## Dashboard screenshots

This directory is the home for captured PNGs of the **Linkz — SLO Overview**
dashboard. Populating it is the one-time task a maintainer does after a
panel change so reviewers without 1 GB of RAM (the observability stack
overhead) can still see what the dashboard looks like.

The text stand-in is [../PREVIEW.md](../PREVIEW.md) and is always kept in
sync with [../slo-overview.json](../slo-overview.json) — start there.

### Conventions

| File | Capture target |
| --- | --- |
| `slo-overview-full.png` | Top-to-bottom screenshot of the dashboard at 1440 px width, time range "Last 6 hours". |
| `slo-overview-row1-availability.png` | SLI: Reservation Availability + outcomes-over-time. |
| `slo-overview-row2-latency.png` | p50/p95 latency panel. |
| `slo-overview-row3-payment.png` | Payment success rate + outcomes (incl. `duplicate` / `noop_stale`). |
| `slo-overview-row4-webhooks.png` | Webhook delivery + attempts vs. terminal outcomes. |
| `slo-overview-row5-error-budget.png` | 30-day error-budget remaining + 1h/6h burn-rate. |
| `slo-overview-row6-operational.png` | Cron sweeps, reconciliation refunds, signature rejections. |

### Capture recipe

1. `docker compose --profile observability up -d`
2. Generate some synthetic traffic so panels have data — e.g. run the
   integration tests against a live stack: `cd reservation-api && npm run
   test:integration`.
3. Open http://localhost:3030/d/linkz-slo-overview, set the time range to
   "Last 6 hours", and use Grafana's panel-menu → **Share → Render image**
   (or the full-page browser screenshot of your choice) for each PNG above.
4. Commit the PNGs here and reference them from the main README.
