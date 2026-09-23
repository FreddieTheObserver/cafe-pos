# Runbook

What to do when CafePOS pages or notifies, and for the incidents `DESIGN.md` §16 names.
Every alert in `ops/prometheus/alerts.yml` links to its section here.

## Before anything else

- **The API** is two instances behind the load balancer.
  `GET /healthz` says a process is alive; `GET /readyz` says it can reach Postgres and Redis, and answers `503 draining` while it is stopping.
- **Metrics** are on each instance's `METRICS_PORT` (9464), never on the public port.
  The Grafana dashboard "CafePOS" shows most of what the sections below ask you to check.
- **Logs** are JSON on stdout.
  Every error response carries a `requestId`, and the same id is on the log line and on the Sentry report.
- **The counter always works without the kiosks.** Cash never touches Stripe, so pausing every kiosk still leaves the cafe trading.

The calls below need a manager's or an admin's access token (`POST /api/v1/auth/login`).

```bash
API=https://<host>/api/v1
TOKEN=<manager access token>
auth=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
```

## Common actions

### Pause and resume a kiosk

A paused kiosk keeps its pairing but refuses new orders, so a customer cannot pay into an outage.

```bash
curl "${auth[@]}" "$API/devices"                                   # find its id
curl "${auth[@]}" -X PATCH "$API/devices/<id>" -d '{"status":"PAUSED"}'
curl "${auth[@]}" -X PATCH "$API/devices/<id>" -d '{"status":"ACTIVE"}'
```

### Revoke a kiosk

For a tablet that is lost, stolen or being retired.
Its token stops working at once and its open socket is cut on every instance.
Revocation is permanent; a replacement is paired from scratch.

```bash
curl "${auth[@]}" -X POST "$API/devices/<id>/revoke"
```

### Revoke a member of staff

Deactivating an account denies its current access token, cuts its sockets on every instance, and stops it refreshing.

```bash
curl "${auth[@]}" -X PATCH "$API/users/<id>" -d '{"isActive":false}'
```

### Look at the payment inbox

Every Stripe webhook is stored before it is acted on.
An event still unprocessed is either waiting for the 30-second sweep or was refused, and a refusal is logged at `error` with its reason (`Refused payment event ...`).

```sql
select provider_event_id, event_type, received_at
from payment_events
where processed_at is null
order by received_at;
```

## Incidents

### Kiosk offline

**Seen as:** `KioskOffline`, or staff reporting a blank or frozen tablet.

1. Check the tablet has power and network.
   It reconnects by itself once it can reach the API.
2. If the API is down too, see [ApiDown](#apidown).
3. If the tablet is damaged or missing, [revoke it](#revoke-a-kiosk) and pair a replacement.

An offline kiosk takes no orders and no money, so nothing needs reconciling.

### Gateway outage

**Seen as:** kiosks answering card and PromptPay payments with 503, `PaymentFailureRatio`, `WebhookLagHigh`, or Stripe's status page.

1. [Pause every kiosk.](#pause-and-resume-a-kiosk) They cannot take money while Stripe is down, and a paused kiosk says so instead of failing at the last step.
2. Keep trading at the counter in cash.
   The cash path never calls Stripe.
3. When Stripe recovers, resume the kiosks.
   Webhooks Stripe could not deliver are retried by Stripe for up to three days and land in the inbox as usual; check [PaymentInboxStuck](#paymentinboxstuck) clears.
4. The next night's reconciliation checks the books against the gateway; see [ReconciliationDelta](#reconciliationdelta) if it disagrees.

### Database failover

**Seen as:** `DatabaseDown`, `/readyz` answering 503 on both instances, requests failing with 500.

1. Check the managed Postgres console: a failover in progress resolves by itself in a minute or two, and the connection pool reconnects on the next query.
2. While it is down, both instances report unready, so the load balancer holds traffic back.
   Kiosks retry with the same idempotency key, so a retried order is created once.
3. After recovery, check nothing was left behind: [PaymentInboxStuck](#paymentinboxstuck) clears as the sweep catches up, and [PendingPaymentOverdue](#pendingpaymentoverdue) clears as expiry catches up.
4. A failover that does not resolve is a restore from backup (PITR).
   That procedure belongs to the database provider, and §16 requires it to have been rehearsed once before launch.

### Token revocation

- **A kiosk:** [revoke it](#revoke-a-kiosk).
- **A member of staff:** [deactivate them](#revoke-a-member-of-staff).
- **Every staff session at once**, for example after a leaked `JWT_SECRET`: rotate `JWT_SECRET` and redeploy.
  Every access token signed with the old key stops verifying; staff sign in again.
  Refresh tokens are stored hashed and are unaffected by the key, so also revoke them with `update refresh_tokens set revoked_at = now() where revoked_at is null;`.
- **The webhook signing secret:** add the new secret first in `STRIPE_WEBHOOK_SECRETS` (newest first, comma-separated), roll it in Stripe, and remove the old one after 24 hours (§10.5).

### Deploying

Instances stop one at a time.
With `SHUTDOWN_DRAIN_SECONDS` set to the load balancer's readiness interval, a stopping instance answers `/readyz` with 503 first, waits for the load balancer to move traffic away, and only then closes, dropping its sockets so each screen reconnects to the instance that is staying up.
Keep the drain under the platform's stop grace period (30 seconds is the usual default).

## Alerts

Each rule is labelled `severity: page` (now) or `notify` (business hours).

### ApiDown

**Page.** No instance is answering Prometheus.
Kiosks cannot take orders.

1. Check the platform: are the instances running, restarting or crash-looping?
   Their logs say why.
2. A crash at boot names its cause, usually configuration: an invalid environment variable, or `STRIPE_MODE` not matching the key.
3. While it lasts, [pause the kiosks](#pause-and-resume-a-kiosk) and trade in cash at the counter if the counter is up.

### InstanceDown

**Notify.** One instance is not answering; the other is carrying the cafe.
Find out why it stopped before the second one does the same.

### DatabaseDown

**Page.** See [Database failover](#database-failover).

### RedisDown

**Notify.** No instance can reach Redis.
What degrades: logins and kiosk pairing are refused (their rate limits cannot be counted), the menu is served uncached, other staff traffic is served without rate limiting, and live events may not cross between instances until Redis is back.
Screens resync from `GET /api/v1/kds/orders` when they reconnect (§5.5).
Restore Redis; nothing needs replaying.

### ReconciliationDelta

**Page.** Last night the gateway and the books disagreed about money.

1. Open the Z-report for the day: `GET /api/v1/reports/z-report?businessDay=YYYY-MM-DD`.
   Its `reconciliation` block shows both totals, the intents the gateway did not report as captured (`notCaptured`), and inbox events never processed (`unmatchedEvents`).
2. An unmatched event is usually the cause: a payment Stripe took but the inbox refused or never processed.
   See [PaymentInboxStuck](#paymentinboxstuck).
3. Compare each `notCaptured` intent in the Stripe Dashboard.
4. A dispute or a refund made in the Dashboard moves money outside this system; record it and settle at the till.

### ReconciliationFailed

**Page.** No instance could check last night's takings against the gateway, which is not the same as the check passing.
Usually Stripe was unreachable at 03:00.
Run the check for that day by opening its Z-report once Stripe is back; the next nightly run covers the next day.

### WebhookProcessingFailures

**Page.** Processing a stored Stripe event threw.
The event is still in the inbox and the sweep retries it every 30 seconds.
Find the `Failed to process payment event` log line; a database error clears when the database does, anything else is a bug.

### PaymentInboxStuck

**Page.** A Stripe event has been unprocessed for more than two minutes: money may have moved with nothing in the system acting on it.

1. [Look at the inbox.](#look-at-the-payment-inbox)
2. A refused event is logged with its reason, for example an amount that disagrees with our row.
   It stays unprocessed on purpose until a human decides; it is also listed in the next Z-report's `unmatchedEvents`.
3. An event that is not refused but stays unprocessed means the sweep is not running or is failing: check both instances are up and the logs for `Could not drain the payment inbox`.

### WebhookLagHigh

**Notify.** Stripe's events are reaching us more than a minute late.
Usually Stripe's side (check its status page) or our endpoint answering slowly.
Customers at a kiosk wait for this event before their QR code clears.

### PaymentFailureRatio

**Notify.** More than 10% of card and PromptPay payments failed over ten minutes.
Check the Stripe Dashboard for a pattern in the declines and for Stripe incidents.
If it is Stripe, treat it as a [gateway outage](#gateway-outage).

### PendingPaymentOverdue

**Notify.** An unpaid order is more than five minutes past its expiry: the expiry job is not reclaiming orders, so their queue numbers are stuck.
Check both instances are up and the logs for `order expiry sweep failed`.
An order whose payment succeeded at the last moment waits for its webhook; if that webhook is stuck, see [PaymentInboxStuck](#paymentinboxstuck).

### KitchenBlind

**Page.** No kitchen screen is connected while the cafe is open, so paid orders are going nowhere.
Check the tablets at the bar: power, network, and whether the barista is signed in.
The KDS snapshot, `GET /api/v1/kds/orders`, lists what they should be showing.

### OrdersSilent

**Notify.** No orders for 15 minutes during opening hours.
Often just a quiet stretch; check a kiosk can still place an order, and whether the counter is taking cash orders at all.
If `BUSINESS_OPEN_TIME` or `BUSINESS_CLOSE_TIME` is wrong, this fires when the cafe is closed.

### KioskOffline

**Notify.** See [Kiosk offline](#kiosk-offline).

### LatencyP95High

**Notify.** A route's p95 is over 300 ms.
The dashboard's latency panel names the route; check the database's slow-query log for it, and the instances' CPU and event loop lag.

### RetentionBehind

**Notify.** Data is being kept past its §7.5 window: customer names, webhook payloads, spent refresh tokens or idempotency keys.
The `data` label says which.
The nightly jobs run at 04:00 Bangkok time and the idempotency sweep hourly; check the logs for `Retention job for <data> failed`.
The next successful run catches up.
