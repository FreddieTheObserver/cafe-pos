# Production readiness

Where each `DESIGN.md` §16 item stands, as of the end of Phase 7's repository work (2026-09-22).
Phase 7's exit criterion is every item ticked, and some can only be ticked by a deployment or by a person.
Each item is one of:

- **Done in the repo**, with the evidence that proves it.
- **Needs a deployment**: the code and tooling are in place, and what is left can only be shown by a running staging or production environment.
- **Needs a person**: a walkthrough, a drill or a decision nobody can make from here.

## Money and data

| Item | Status | Evidence, or what is left |
|---|---|---|
| Reconciliation green for 7 consecutive days in staging (delta = 0) | Needs a deployment | The nightly job, `ReconciliationDelta` and `ReconciliationFailed` alerts, and `reconciliation_runs_total` are in place. Seven clean nights need a staging environment taking test-mode payments. |
| Webhook crash-recovery test passed | Done in the repo | `test/crash-recovery.e2e-spec.ts`: a handler killed after acking Stripe recovers, exactly once however many sweeps run. |
| Idempotency verified end to end (retry storm: 1 order, 1 charge) | Done in the repo | `test/orders-http.e2e-spec.ts` ("survives two identical requests in flight at once"), and the cash payment race in `test/create-payment.e2e-spec.ts`. |
| PITR backups enabled; a restore actually performed; RPO/RTO measured | Needs a deployment and a person | Depends on the managed Postgres. The runbook's database failover section points at it. |
| Retention jobs running and observed | Done in the repo; running needs a deployment | `src/retention/`, `retention_overdue_rows`, the `RetentionBehind` alert, and `test/retention.e2e-spec.ts`. |

## Security

| Item | Status | Evidence, or what is left |
|---|---|---|
| TLS only, HSTS; secrets in a platform store, none in the repo (gitleaks) | HSTS and the secret scan done in the repo; TLS needs a deployment | helmet sets HSTS on every response. CI runs gitleaks over every commit (`.gitleaks.toml`); the history is clean. TLS is terminated at the load balancer. |
| Webhook signatures verified with the production secret; live and test keys cannot cross | Done in the repo; the production secret needs a deployment | Signature verification in `stripe-webhook.controller.spec.ts`; `STRIPE_MODE` refuses a key from the other mode, live mode outside production, and a live key pointed away from Stripe (`src/config/env.validation.spec.ts`). |
| AuthZ matrix sweep green; kiosk token blast radius pen-checked (T1, T2, T5) | Sweep done in the repo; the pen-check needs a person | `test/authz-matrix.e2e-spec.ts`. The manual check of a stolen kiosk token against §10's threats is a person's job. |
| Rate limits live and observed in metrics; login lockout verified | Done in the repo | `rate_limit_rejections_total{rule}` and `rate_limit_backend_unavailable_total{policy}`; lockout in `test/login-attempt-limiter.e2e-spec.ts`. |
| `npm audit` clean or triaged; Dependabot on | Done in the repo | `docs/security/dependency-audit.md`; `.github/dependabot.yml`; a weekly audit workflow. Dependabot starts once the configuration is on GitHub. |

## Operations

| Item | Status | Evidence, or what is left |
|---|---|---|
| 2 instances behind a load balancer; zero-downtime deploys (drain WS on SIGTERM, 30 s or less) | The application half done in the repo; the rest needs a deployment | `ShutdownDrain` reports unready, waits `SHUTDOWN_DRAIN_SECONDS`, then closes and drops sockets (`test/shutdown.e2e-spec.ts`). Two instances and the load balancer are infrastructure. |
| Health endpoints wired to platform restarts | Endpoints done in the repo; the wiring needs a deployment | `/healthz` and `/readyz`, excluded from the API prefix and from rate limiting. |
| All §13 alerts firing in a drill, routed to a phone someone answers | Rules done in the repo; the drill and routing need a deployment and a person | `ops/prometheus/alerts.yml`, each with a case that fires and one that must not (`promtool test rules` in CI), each linking to its runbook section. `ApiDown` was seen going pending against the local stack. Alertmanager receivers are deployment configuration. |
| Runbook written: kiosk offline, gateway outage, DB failover, token revocation | Done in the repo | `docs/runbook.md`, plus a section for every alert. |
| Load test at 3x peak green within 7 days of the launch build | Script done in the repo; the gating run needs the launch build | `ops/load/cafepos.k6.js` and `ops/load/verify.sql`. A 90-second smoke run passed locally (p95 16 ms, no errors, all invariants clean). |

## Product

| Item | Status | Evidence, or what is left |
|---|---|---|
| Business-day boundary, VAT rate, currency and order-expiry TTL configurable and confirmed with the owner | Configurable done in the repo; confirmation needs a person | All four are environment settings, validated at boot. So are opening hours, which the business-hours alerts read. |
| Z-report walked through with the owner against a day of test orders | Needs a person | `GET /api/v1/reports/z-report`. |
| Kiosk "backend unreachable" screen tested by pulling the network cable | Needs a person | The kiosk client lives outside this repository. |
| Staff trained: pairing and revoking a device, refunds, 86ing | Needs a person | The runbook's common actions cover pairing, pausing and revoking. |
