# Phase 6, slice 1 — the nightly sales rollup job

**Date:** 2026-08-10
**Status:** approved, not yet implemented
**Scope:** the `daily_sales_rollups` producer only. No `/reports/*` endpoints.

## Why this slice exists

`DESIGN.md` §11.2 lists "reporting queries vs OLTP" as the first thing that breaks: ad-hoc
date-range aggregates over a growing `orders` table start stealing I/O from order-taking. The
stated mitigation is a nightly rollup that makes historical reports O(days), leaving only "today"
against live tables.

The table has existed since migration `0000` and has never been written to. This slice writes to
it. The endpoints that read it come next, and can then be built against a populated table rather
than against a promise.

## Decisions

Five questions were settled before design. Each is recorded with its reasoning, because the
reasoning is what a later reader needs when the decision looks arbitrary.

### 1. `revenue_minor` is payment-derived and gross

Sum of `payments.amount_minor` where `payments.status = 'SUCCEEDED'`, joined to orders on the
business day. Refunds are a **separate offset line**, not a subtraction — a fully refunded order
keeps its revenue and is also counted in `orders_refunded`.

§5.3's worked example settles this on its own, and is worth reproducing because it is a
self-checking specification:

```
CARD 2,100,000 + PROMPTPAY 2,300,000 + CASH 412,000 = 4,812,000   = revenueMinor.total
CARD 2,100,000 + PROMPTPAY 2,300,000                = 4,400,000   = reconciliation.dbRecordedMinor
```

Cash is in the revenue total and out of the gateway comparison, exactly as it must be. The
alternative bases both fail against this example: order-derived revenue leaves
`revenue_by_method` with no source at all, since `method` lives on `payments`; and a net figure
contradicts §5.3 showing `revenueMinor.total` and `refundsMinor` as separate numbers.

### 2. Missed days are recovered by a bounded catch-up sweep

The cron targets one day. An outage spanning a weekend would otherwise leave permanent holes
that surface months later as a blank report — and silently retire §11.2's O(days) promise for
those dates.

So each run also sweeps `[target - 30 days, target)` for business days that have orders but no
rollup row carrying `finalized_at`, and rolls those too. Bounded at 30 days so the sweep can
never become a full table scan. The recompute is deterministic, so re-running is safe.

`finalized_at` therefore means *"last successfully computed"*, not *"sealed"*. This is deliberate:
sealing the row would freeze any aggregation bug into every day it touched, recoverable only by
hand-written SQL.

### 3. No lock — and §11.3 gets amended

§11.3 states that jobs including rollups are "guarded by Redis locks (`SET NX`)". No such helper
exists in the codebase, and the expiry job deliberately runs lock-free with a written rationale.

This job follows expiry. The target day is closed — at 03:00 the current business day is still
yesterday's, so `now - 24h` names a day that ended 22 hours earlier — and §3.3 freezes that day's
refunds. The aggregation over it is therefore deterministic: two instances compute identical
numbers and the upsert converges. A double run costs one duplicated aggregation at 03:00, inside
§3.3's dead zone.

A lock would buy no correctness here, and the Redis variant would buy a new failure mode: fail-open
means both instances run anyway, and fail-closed means a Redis blip silently skips the night.

**§11.3 must be amended** to say rollups are idempotent rather than lock-guarded. That amendment
belongs in this slice, since it is the prose the code contradicts.

### 4. Unresolvable payment methods go in an `UNKNOWN` bucket

`payments.method` is nullable — migration `0005` made it so, and the reconciliation service's own
comment records that an unresolvable method is stored as null because "a coffee is worth more than
a label". That money is real revenue with no bucket.

It is bucketed under an explicit `UNKNOWN` key. This preserves the invariant a Z-report exists to
guarantee — the method breakdown accounts for the stated total — and makes the oddity visible to
whoever signs off the day, rather than silently absent.

Note for accuracy: `payments.method` carries a check constraint restricting it to
`CARD | PROMPTPAY | CASH`, so adding a payment rail *does* require a migration. What is dynamic
here is only that the reporting code derives its keys from `GROUP BY` instead of hardcoding them,
so a new rail touches the enum and the migration but not this module.

### 5. `top_items` holds every item sold that day, not a truncated leaderboard

§5.2's `GET /reports/top-items?from&to` spans multiple days, and truncated per-day lists cannot be
summed into an exact range answer: an item ranked #11 every day for a week can outsell a spiky #3
and appear in no stored list, with nothing in the data revealing the omission.

Storing one entry per item sold makes range queries exact by simple summation. A single-location
cafe has a bounded menu, so the cost is about 8 KB/day for a 100-item menu — roughly 3 MB/year.
Each entry carries both quantity and revenue so either sort order is served from one payload.

The column keeps its `top_items` name; the contents are a superset of one.

## Design

### Placement

Mirrors `src/payments/reconciliation/`:

```
src/reporting/reporting.module.ts
src/reporting/rollup/daily-rollup.service.ts     @Cron, the five queries, the upsert
src/reporting/rollup/build-rollup-row.ts         pure assembly, no DB
src/reporting/rollup/build-rollup-row.spec.ts    unit
test/daily-rollup.e2e-spec.ts                    against real Postgres
```

`ReportingModule` is wired into `AppModule` alongside `PaymentsModule`.

### Schedule and target selection

```ts
@Cron(CronExpression.EVERY_DAY_AT_3AM, {
  name: 'roll-up-yesterday',
  timeZone: 'Asia/Bangkok',
})
```

Identical expression and timezone to reconciliation. The target day is
`businessDayOf(new Date(now - 24h), BUSINESS_TIMEZONE, BUSINESS_DAY_START_HOUR)`.

The literal `'Asia/Bangkok'` in the decorator duplicates the configurable `BUSINESS_TIMEZONE`
(same default). This is not an oversight and is not being fixed here: a decorator is evaluated at
class-definition time and cannot read `ConfigService`. Reconciliation has the same shape, and
diverging from it would be worse than matching it.

Catch-up, run after the target day:

```sql
SELECT DISTINCT o.business_day
  FROM orders o
 WHERE o.business_day >= :target - interval '30 days'
   AND o.business_day <  :target
   AND NOT EXISTS (SELECT 1 FROM daily_sales_rollups r
                    WHERE r.business_day = o.business_day
                      AND r.finalized_at IS NOT NULL)
 ORDER BY o.business_day
```

Served by `orders_business_day_status_idx`. Days are rolled oldest-first, each independently, so
one failure does not abort the rest.

### What counts

Status counts are plain counts by terminal status.

Revenue, VAT and top-items all key off **one** predicate: the order has at least one `SUCCEEDED`
payment. Using a single predicate for all three is what keeps the Z-report internally consistent —
a VAT figure computed over a different set of orders than the revenue figure would be indefensible
at the counter.

The predicate is expressed once, as an `EXISTS`, and reused verbatim by q4 and q5:

```sql
EXISTS (SELECT 1 FROM payments p
         WHERE p.order_id = o.id AND p.status = 'SUCCEEDED')
```

Five queries, in one `REPEATABLE READ` transaction so they see one snapshot:

| Query | Source | Produces |
|---|---|---|
| q1 | `orders` grouped by `status` | `orders_completed`, `orders_refunded`, `orders_cancelled`, `orders_expired` |
| q2 | `payments ⋈ orders`, `payments.status='SUCCEEDED'`, grouped by `method` | the by-method buckets |
| q3 | `refunds ⋈ payments ⋈ orders`, `refunds.status='SUCCEEDED'` | `refunds_minor` |
| q4 | `order_items ⋈ orders` where the predicate holds, grouped by `menu_item_id, name_snapshot` | `top_items` |
| q5 | `orders` where the predicate holds — **no join to items** | `vat_minor` |

**q5 is separate from q4 on purpose.** Summing `orders.vat_minor` across the `order_items` join
would add each order's VAT once per line on the ticket, so a three-item order would contribute
triple. VAT is a per-order figure and has to be summed over distinct orders. The two queries are
kept adjacent in the code with this note attached, because the merged version looks like an
obvious optimisation to anyone who has forgotten why it is wrong.

The transaction is a consistency belt-and-braces: the day is closed, so the five queries could not
disagree in practice. It costs nothing and removes the need to reason about that claim.

### A day with no trade

The target day is rolled unconditionally — a day the cafe never opened gets a row of zeros with
`finalized_at` set, which records that the day was checked rather than missed. The catch-up sweep
selects from `orders` and so only ever revisits days that saw trade; it cannot manufacture zero
rows for arbitrary past dates, which is what a calendar-driven sweep would do.

### The pure function

```ts
export interface RollupParts {
  statusCounts: { status: OrderStatus; count: number }[];
  revenueByMethod: { method: PaymentMethod | null; totalMinor: number }[];
  refundsMinor: number;
  vatMinor: number;
  items: { menuItemId: string; name: string; quantity: number; revenueMinor: number }[];
}

export function buildRollupRow(businessDay: string, parts: RollupParts): RollupRow;
```

Responsibilities:

- null method → the `UNKNOWN` key
- absent statuses → `0` rather than undefined
- items sorted by quantity descending, then name, so two runs produce a byte-identical row
- `revenue_minor` computed **as the sum of the by-method buckets**

That last point is the reason this function exists. Deriving the total from the buckets rather than
querying it separately makes `Σ by_method == revenue_minor` true by construction. There is no
assertion to write, because there is no path by which it can be false.

### The write

One statement per day:

```sql
INSERT INTO daily_sales_rollups (...) VALUES (...)
ON CONFLICT (business_day) DO UPDATE SET ..., finalized_at = now()
```

### Failure handling

A day that throws is logged at `error` naming the day, and left with **no** `finalized_at`, so the
next night's sweep retries it. The job returns a summary of days rolled and days failed.

This borrows reconciliation's stance — never write a number you are not sure of — and diverges on
recovery. Reconciliation can only report, so a failure there is terminal and returns `null`. A
rollup retry is free, so a failure here is simply deferred.

## Testing

**Unit, no database** (`build-rollup-row.spec.ts`): `UNKNOWN` bucketing; a day with no trade at
all; missing statuses defaulting to zero; item merging and deterministic ordering; and aggregate
sums past int32, since the `bigint` columns exist precisely because a day's revenue can exceed what
the per-row `integer` columns hold.

**E2E, real Postgres** (`daily-rollup.e2e-spec.ts`): seed one business day with a deliberate mix —
all four terminal statuses, all three payment methods, a partial refund, and a null-method
payment — then run the job and assert the row. Run it a second time and assert the row is
byte-identical. Delete a middle day's rollup and assert the sweep restores it.

The seed must include **at least one order with several distinct line items**, and the expected
`vat_minor` must be computed by hand from the orders rather than from the fixture's item rows.
That is the only shape that catches the q4/q5 merge: with one item per order, a VAT sum taken
across the item join is indistinguishable from a correct one.

**Falsification.** Per the Phase 5 lesson, the catch-up test gets checked by deleting the sweep and
confirming it goes red. A test for catch-up that passes without catch-up code is worth nothing, and
this repo has already been bitten once by not checking.

## Out of scope

- `GET /reports/sales`, `/reports/top-items`, `/reports/z-report` — the next slice.
- The `provisional: true` flag for a partial current day (`DESIGN.md`:902) — a property of the
  read path, not the producer.
- Any read replica work from §11.2's "next step".

## DESIGN.md amendment owed by this slice

§11.3 currently reads that jobs "(expiry, rollups)" are "guarded by Redis locks (`SET NX`) so N
instances don't double-run them". Neither job works that way, and neither needs to. The sentence
should describe what makes them safe — idempotency — rather than a mechanism the codebase does not
contain.
