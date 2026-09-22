# Phase 7, slice 1 - metrics and alert rules

**Date:** 2026-09-22
**Status:** design, not yet implemented
**Branch:** `phase7-metrics`
**Scope:** a Prometheus `/metrics` endpoint on its own port, the §13 metrics plus the few this design adds, the §13 alerts as tested Prometheus rules, and a local Prometheus and Grafana in docker-compose.
**Depends on:** Phases 0-6 and PR #18, all on `main` at `5c61628`.

## Why this slice exists

§13 says a system taking money unattended must make silent failure impossible.
Today it is possible.
Logging is structured JSON and `/healthz` exists, but nothing produces a number an alert can watch.

The worst case is concrete.
A non-zero reconciliation delta is the one event §13 says must page a human, and today it becomes a log line nobody is watching.

Metrics also come first because several §16 items depend on them.
"Retention jobs running and observed", "rate limits live and observed in metrics", the alert drill, and the load test's p95 target cannot be ticked until the numbers exist.

## Decisions

Seven questions were settled before design.
The first four were put to the user, and the other three follow from the codebase.

### 1. `/metrics` lives on its own port

A second listener on `METRICS_PORT` (default `9464`) serves `GET /metrics` and nothing else.
The load balancer routes only the API port, so the endpoint is never on the public internet.
None of the API's guards, its throttler, or its `@Public` policy touch it.

Two alternatives were rejected.
The API port with a bearer token puts an internet-facing endpoint's safety on a secret.
The API port hidden by load balancer path rules means one misconfigured deploy publishes the cafe's order and payment counts.

The listener is a Nest provider, `MetricsServer`, started explicitly by `main.ts` after `app.listen()` and closed by the shutdown hooks `configureApp` already enables.
It is not started on module init, so the ~40 e2e suites that boot `AppModule` do not each open a port.
The metrics suite starts it on port 0.

### 2. Opening hours are configuration, exported as a metric

Three alerts only mean something while the cafe is open: no orders for 15 minutes, no kitchen screen connected, and a kiosk offline.
The app knows when a business day starts (`BUSINESS_DAY_START_HOUR`) but not when the cafe opens.

Two new variables, `BUSINESS_OPEN_TIME` and `BUSINESS_CLOSE_TIME`, are `HH:MM` in `BUSINESS_TIMEZONE`.
They default to `07:00` and `20:00`, the business hours §3's availability target already assumes.
A window whose close is earlier than its open wraps past midnight, and equal times are rejected.
The app exports `business_open` (1 or 0), computed at scrape time by a pure `isOpenAt(instant, timeZone, open, close)`, and the gated alerts multiply by it.

Writing the hours into the rule files was rejected.
It duplicates the schedule outside the app's config, and it has to be written in UTC because PromQL's `hour()` is.
Dropping the condition was rejected because `OrdersSilent` would then page every night the cafe is closed.

One daily window covers a single cafe.
Per-weekday hours and holidays are out of scope.

### 3. The slice ships rules, Prometheus and Grafana

Beyond the endpoint, the slice ships the §13 alerts as a Prometheus rules file tested by `promtool test rules` in CI.
It also adds Prometheus and Grafana to `docker-compose.yml`, with one provisioned dashboard.
The load test later in Phase 7 needs somewhere to watch p95, and an alert rule nobody has executed is untested code in the same way as a query nobody has run.

Routing alerts to a phone (Alertmanager receivers) is deployment, not this repo.
Every rule carries a `severity` label of `page` or `notify` so that routing has something to key on.

### 4. Stuck webhook events get a gauge, not just a counter

§13's `webhook_processing_failures_total` would misreport the case that matters most.
A REFUSEd event is deliberately left with `processed_at` NULL, and the 30-second sweep refuses it again every tick.
One bad event would look like a steady stream of failures.
A process that dies between the ack and the transition, meanwhile, leaves no failure to count at all.

So the counter stays, counting only processing exceptions.
A new gauge, `payment_inbox_oldest_unprocessed_age_seconds`, answers the direct question: is any money event sitting unhandled?
It covers REFUSE, crashes, and a dead sweep with one number, and one stuck event pages once rather than every 30 seconds.

A lost race is not counted as a failure.
Two instances can apply the same event at once: both read it unprocessed, and the second's guarded `PENDING_PAYMENT -> PAID` transition then finds the order already paid and throws.
Today that is logged at `error`.
Counted, it would page on the system working correctly, so `processEvent` treats it the way the expiry sweep already does (`isLostRace`): logged at `debug`, not counted.
Nothing is lost by this, because the transaction rolled back and the row is re-read by the next sweep, where the inbox gauge is what notices if it never settles.

### 5. Each app has its own registry, and `prom-client` is used directly

`realtime-two-instances.e2e-spec.ts` boots two `AppModule`s in one process.
`prom-client`'s global default registry would make the second boot throw "metric already registered", or worse, let two instances silently share counters.
`MetricsModule` therefore provides a fresh `Registry` per app.

`@willsoto/nestjs-prometheus` was rejected because it defaults to the global registry and serves metrics through a controller on the API port, which is decision 1's rejected option.
OpenTelemetry metrics with a Prometheus exporter were rejected for this slice.
`prom-client` is smaller and the de facto standard, and §13's OTel is for tracing, which can adopt it independently later.

Node's default metrics (event loop lag, heap, GC) are registered only when `MetricsServer` starts.
They attach process-wide observers that are never released, and Phase 5 showed that per-boot leaks in a test run starve the suites that run last.

### 6. A count moves only when the fact it counts has committed

A counter incremented inside a transaction that then rolls back reports something that never happened.
That is the same lie the after-commit seam exists to keep off the KDS.
So every domain counter is incremented after its transaction commits, and only when its guarded write actually matched a row.

Two cases make this concrete.
An idempotent replay of `POST /orders` returns the stored order and must not count a second order.
Two instances draining the same inbox event both run the processor, but only one guarded write lands, and only that one counts a payment.

### 7. A read that fails exports nothing, never the last value

Several gauges are read from the database at scrape time.
If a read fails or exceeds its 2-second deadline, that gauge is reset and exported with no value, `metrics_collector_failures_total{collector}` is incremented, and the rest of the scrape is served.

A stale value would claim a fact nobody checked, such as a kiosk age of 30 seconds that is really an hour old.
This is Phase 4's reconciliation rule again: "we could not check" and "we checked and it is fine" are opposite facts.

A failed collector must also not fail the whole scrape.
Prometheus would then mark the instance down and page `ApiDown` for what is a database problem, which has its own alert.

## Design

### Metric catalog

Names follow §13.
Metrics marked **new** are not in §13 and are added to it by this slice.

**Counted at the source**

| Metric | Type | Labels | Moves when |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_class` | an API-port response finishes, except `/healthz` and `/readyz` |
| `orders_created_total` | counter | `channel` | an order is created and committed, and not on an idempotent replay |
| `payments_total` | counter | `provider`, `status` | a payment's guarded write to `SUCCEEDED`, `FAILED` or `CANCELLED` lands |
| `webhook_processing_failures_total` | counter | - | `processEvent` or the inbox sweep throws |
| `webhook_lag_seconds` | histogram | - | a webhook event is stored for the first time, observing receipt time minus the gateway's `created` |
| `reconciliation_runs_total` **new** | counter | `outcome` = `agreed`, `delta`, `failed` | the nightly reconciliation finishes or fails |
| `reconciliation_delta_minor` | gauge | - | set by the nightly job, and cleared when a run fails |
| `rate_limit_rejections_total` **new** | counter | `rule` | a request is refused for exceeding a rate limit, including the login lockout |
| `rate_limit_backend_unavailable_total` **new** | counter | `policy` = `refuse`, `allow` | the Redis limiter is unreachable and the route's outage policy is applied |

**Read at scrape time**

| Metric | Type | Labels | Source |
|---|---|---|---|
| `orders_pending_payment_overdue_seconds` (replaces `orders_pending_payment_age_seconds`) | gauge | - | max of `now - expires_at` over `PENDING_PAYMENT` orders, 0 when none are overdue |
| `payment_inbox_oldest_unprocessed_age_seconds` **new** | gauge | - | `now - min(received_at)` over inbox rows with `processed_at` NULL, 0 when there are none |
| `kiosk_last_seen_age_seconds` | gauge | `device` (id) | `now - last_seen_at` for each `ACTIVE` device |
| `ws_connected` | gauge | `namespace` = `kds`, `kiosk`, `board` | this instance's local socket count per namespace |
| `dependency_up` **new** | gauge | `dependency` = `postgres`, `redis` | `HealthService.checkReadiness()` |
| `business_open` **new** | gauge | - | `isOpenAt` from decision 2 |
| `metrics_collector_failures_total` **new** | counter | `collector` | a scrape-time read failed (decision 7) |

Node's default `process_*` and `nodejs_*` metrics are exported as well.

The rows that differ from §13:

- **Pending payment is measured as overdue time, not age.**
  §13 alerts on an age above 15 minutes because the TTL is 10, so the alert really asks whether the expiry job has stopped.
  An age threshold hardcodes the TTL into the rule, and §16 makes the TTL configurable.
  Overdue time asks the question directly and holds at any TTL.
  It also catches an expired order left waiting for its webhook (the `ALREADY_SUCCEEDED` path), which is a stuck payment too.
- **`ws_connected` is labelled by namespace.**
  §13 says `room`, but the audiences are the three namespaces.
  Rooms are per device or per user, which would make the label unbounded.
- **`payments_total` gains `provider`.**
  Cash cannot fail, so counting it would dilute the gateway failure ratio the alert is about.
- **The HTTP histogram gains `method` and `status_class`.**
  `status_class` (`2xx` to `5xx`) keeps the series count bounded while still letting a dashboard separate errors.
  `route` is the matched Express pattern including the prefix, for example `/api/v1/orders/:id`, and `unmatched` when nothing matched.
  Neither UUIDs nor a scanner's paths can grow the series count.
  The buckets include `0.3`, so the 300 ms alert does not interpolate across a bucket.

Every labelled counter is initialized at 0 for its known label values at startup.
`increase()` then has a series from the first scrape rather than from the first event.

`GatewayEvent` gains `createdAt`, taken from Stripe's `event.created`, so webhook lag can be measured without re-parsing the payload.
`webhook_lag_seconds` is observed only when the inbox insert stores a new row.
A duplicate delivery is Stripe retrying an event we already hold, and observing it would report lag for an event that was never late.

### Where the code lives

`src/observability/metrics/`:

- `metrics.ts` defines the counters and histograms, and the in-memory gauges (`reconciliation_delta_minor`, `ws_connected`).
  `Metrics` is the typed facade producers inject: orders, payments, webhooks, reconciliation, the throttler and the gateways.
- `scraped-gauge.ts` is the one primitive behind every gauge read at scrape time, and the only place decision 7's failure rule lives.
  prom-client's `reset()` puts an unlabelled gauge back to 0, so a plain gauge cannot say "unknown"; `ScrapedGauge` overrides `get()` and exports exactly what this scrape read.
- `MetricsModule` is `@Global()`, like `RealtimeModule`, and provides the per-app `Metrics` and `MetricsServer`.
  It has no dependencies, so the probe-module suite that boots without a database can still run `configureApp`.
- `StateGaugesModule` registers the gauges that need the database, the readiness checks, or config.
  It is separate from `MetricsModule` for the same reason.
- The gateways register their namespaces with `Metrics` in `afterInit`, so `ws_connected` reads live socket counts without the metrics module importing realtime.

`isOpenAt` lives in `src/orders/business-hours.ts`, beside `businessDayOf`, because opening hours are a trading fact rather than a monitoring one.

The HTTP timing middleware is installed by `configureApp`, so every e2e suite exercises it through the same code path production uses.

The rate-limit rule a rejection is counted under comes from `@RateLimit`, which takes the rule's name (`@RateLimit('login')`) rather than the rule object, so the guard can read it back.
The per-account login lockout is counted as `loginAccount`.

### Alert rules

The rules live in `ops/prometheus/alerts.yml`.
Counters are summed across instances.
Database-derived gauges are reported identically by every instance and are read with `max`.

| Alert | Condition | For | Severity |
|---|---|---|---|
| `ApiDown` | no instance is up | 1m | page |
| `InstanceDown` | one instance is down | 2m | notify |
| `DatabaseDown` | `dependency_up{dependency="postgres"}` is 0 | 1m | page |
| `RedisDown` | `dependency_up{dependency="redis"}` is 0 | 2m | notify |
| `ReconciliationDelta` | `reconciliation_delta_minor` is not 0 | - | page |
| `ReconciliationFailed` | a `failed` run in the last day, and no instance completed one | - | page |
| `WebhookProcessingFailures` | any failure in the last 10 minutes | - | page |
| `PaymentInboxStuck` | oldest unprocessed event older than 120 s | - | page |
| `KitchenBlind` | no `kds` socket on any instance, while open | 2m | page |
| `WebhookLagHigh` | p95 lag above 60 s over 10 minutes | - | notify |
| `PaymentFailureRatio` | Stripe `FAILED` above 10% of `SUCCEEDED` + `FAILED` over 10 minutes, with at least 5 attempts | - | notify |
| `LatencyP95High` | a route's p95 above 300 ms on at least 3 requests a minute, excluding `/api/v1/reports/*` and `unmatched` | 5m | notify |
| `PendingPaymentOverdue` | an order more than 5 minutes past its expiry | - | notify |
| `OrdersSilent` | no orders in 15 minutes, while open for all 15 | - | notify |
| `KioskOffline` | an `ACTIVE` kiosk unseen for 120 s, while open | - | notify |

Where this departs from §13, and why:

- **`KitchenBlind` pages.**
  §13 routes nothing for it.
  With no kitchen screen, customers who have paid wait for drinks nobody knows to make, which is money taken without service.
- **`PaymentInboxStuck` and `ReconciliationFailed` page**, as members of the same families as webhook failures and the reconciliation delta.
- **The failure ratio needs 5 attempts.**
  At 07:00, one declined card in three payments is 33%, and that is a customer, not an incident.
- **Reports are excluded from the latency alert.**
  A closed day's Z-report calls Stripe once per payment, deadlined at 5 seconds.
  One manager opening it would breach a 300 ms p95 on its own.
- **The latency alert needs traffic.**
  On a quiet route, one slow request is the whole p95 for five minutes, so a route has to carry at least 3 requests a minute before its p95 can alert.
  `unmatched` is excluded too: a scanner's 404s say nothing about how the cafe's routes perform.
- **`ReconciliationFailed` needs every instance to have failed.**
  Both instances run the nightly job, and one hitting a Stripe blip while the other checks the books successfully is not a night nobody checked.
- **`OrdersSilent` requires the cafe to have been open for the whole window**, so the first 15 minutes after opening cannot fire it.

### Local stack

`docker-compose.yml` gains `prometheus` on port 9090 and `grafana` on port 3001, since the API has 3000.
Both are pinned, like the existing images, and both sit behind an `observability` profile.
A plain `docker compose up -d` still brings up only what the tests need, and `docker compose --profile observability up -d` adds the monitoring.

Prometheus scrapes the app on the host through `host.docker.internal:9464`, with a `host-gateway` mapping so the same file works on Linux.
It loads `alerts.yml`, so the rules can be watched evaluating locally.

Grafana is provisioned with the Prometheus datasource and one dashboard, `ops/grafana/dashboards/cafepos.json`.
It shows request rate and p95 by route, orders, payments by status, webhook lag and inbox age, pending overdue time, kiosk ages, connected screens, reconciliation, rate-limit rejections, and dependency status.

### Configuration

| Variable | Default | Validation |
|---|---|---|
| `METRICS_PORT` | `9464` | 1-65535, and different from `PORT` |
| `BUSINESS_OPEN_TIME` | `07:00` | `HH:MM` |
| `BUSINESS_CLOSE_TIME` | `20:00` | `HH:MM`, and not equal to the open time |

## Testing

Phase 6's lesson applies here: the prescribed tests are the weakest part of a plan.
Each load-bearing test below names the wrong implementation it rules out.

**Unit (no database)**

- `isOpenAt`: inside, outside, both edges, a window that wraps midnight, and a zone with daylight saving, so the wall-clock logic is proven where the offset moves.
- Route labelling: a matched route gives its pattern, and an unmatched request gives `unmatched`.
- Collector isolation: a collector that throws, or exceeds its deadline, leaves its gauge empty and counts one failure, and the rest of the scrape is still served.
  This rules out catching the error but keeping the old value.
- Env validation for the three new variables.
- **Cross-check:** every metric name in `alerts.yml` and in the Grafana dashboard (allowing `_bucket`, `_sum` and `_count`) is registered by the app.
  Otherwise a renamed metric leaves an alert silently evaluating nothing, which is the config-invisible-to-tests failure PR #5 taught.

**E2E (`test/metrics.e2e-spec.ts`, plus assertions in existing suites where the event already happens)**

- The API port answers 404 for `/metrics`, and the metrics port serves the Prometheus text format.
- Two `GET /orders/:id` calls with different ids produce **one** series labelled `/api/v1/orders/:id` with a count of 2.
  This rules out labelling by `req.path`.
- `POST /orders` moves `orders_created_total{channel="KIOSK"}` by exactly 1, and replaying the same idempotency key moves it by 0.
  This rules out incrementing before the replay check.
- A signed webhook observes one lag sample, and redelivering the same event observes none.
- Processing the same inbox event twice counts one `SUCCEEDED` payment.
  This rules out counting unguarded writes.
- An unprocessed inbox row 10 minutes old reads at least 600 on the inbox gauge, and 0 once it is processed.
- An order 6 minutes past `expires_at` reads at least 360 on the overdue gauge.
- An `ACTIVE` kiosk reports an age, and a `REVOKED` one does not appear.
- A connected KDS socket reads `ws_connected{namespace="kds"} 1`.
- The nightly reconciliation sets `reconciliation_delta_minor`, a Z-report for the same day does not touch it, and a run with an unreachable gateway clears it and counts `failed`.
  This rules out the Z-report writing an alarm value, and a failed run leaving yesterday's zero standing.
- A rate-limited request counts one rejection under its rule, without spending the shared login budget.
- In the two-instance suite, a counter moved on one app is absent from the other app's scrape.
  This rules out a shared global registry.

**Alert rules (`promtool test rules`, in CI)**

Every alert has at least one case that must fire and one that must not.
Each gated alert has a closed-hours case that must not fire.
`PaymentFailureRatio` has a below-volume case, and `OrdersSilent` has a just-opened case.
CI also runs `promtool check config` on the local Prometheus config, both through the pinned `prom/prometheus` image.

**Falsification**

The replay, guarded-write, route-pattern and registry-isolation tests are each run once against the broken variant they rule out.
Each must go red before the fix is accepted.

## `DESIGN.md` amendments

- §13 metric table: the renamed and added metrics above, and `ws_connected` labelled by namespace.
- §13 routing: `KitchenBlind`, `PaymentInboxStuck` and `ReconciliationFailed` page, and the new notify alerts are listed.
- §3 and the trading settings: business hours become `BUSINESS_OPEN_TIME` and `BUSINESS_CLOSE_TIME` rather than a stated assumption.

## Out of scope

- Tracing (OpenTelemetry) and Sentry, which are the next observability slice.
- Alertmanager receivers and routing to a phone, and a dead man's switch for Prometheus itself, which are deployment.
- Log shipping to Loki or CloudWatch, since the logs are already structured JSON on stdout.
- Retention jobs, the load test and the runbook, which are later Phase 7 slices that this one makes observable.
- A metric for the nightly rollup job.
  Reports fall back to live aggregation for an unrolled day, so a failed rollup costs speed, not correctness.
  It belongs with the retention jobs, which need the same "did the nightly job run" signal.
- Platform metrics for Postgres and Redis themselves (connections, replication, disk), which §13 leaves to platform defaults.
