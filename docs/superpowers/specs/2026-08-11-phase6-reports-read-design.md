# Phase 6, slice 2 — the reporting read endpoints

**Date:** 2026-08-11
**Status:** approved, not yet implemented
**Scope:** `GET /reports/sales`, `GET /reports/top-items`, `GET /reports/z-report`, plus the shared aggregation seam and migration `0006` they require.
**Depends on:** slice 1 (the nightly rollup producer), merged as `72e6f55` and `0da1e91`.

## Why this slice exists

Slice 1 filled `daily_sales_rollups` so historical reports would be O(days) instead of scanning
live order tables (§11.2). Nothing reads it yet. FR-19 (sales reports) and FR-20 (Z-report) are
this slice, and §17's exit criterion for Phase 6 — *"Z-report matches hand-computed totals over
seeded data"* — is met here or not at all.

## Decisions

Five questions were settled before design.

### 1. A range is stitched, and `provisional` means "still trading"

§11.2 names two cases — history from rollups, today from live tables. There is a third it does not
name: a day that **closed hours ago but has not been rolled yet**. The nightly job runs at 03:00 and
targets the day that closed 22 hours earlier, so between a day's close and its roll there is a
window where the day is final but unrolled.

Resolution per day in range:

| Day | Source | Flags `provisional`? |
|---|---|---|
| Closed, has finalized rollup | the stored row | no |
| Closed, no rollup yet | live aggregate | **no** |
| The currently open business day | live aggregate | **yes** |

A closed-but-unrolled day is *not* provisional. §3.3 froze its refunds at close, so the live
aggregate is precisely the number the rollup would later produce. Flagging it would make
`provisional` mean "not cached yet" instead of "incomplete", and a manager pulling yesterday's
report at 08:00 would see a warning that means nothing.

`provisional: true` therefore holds exactly when the requested range includes the open business day.

### 2. `groupBy=hour` is live-only and capped at 31 days

`daily_sales_rollups` is one row per day, so hourly buckets have no stored source and must come from
`orders`. The general validation rule allows 366-day ranges, which at hourly granularity is ~8,800
buckets scanned off the OLTP tables — §11.2's first-to-break, reintroduced deliberately.

`groupBy=day` keeps the full 366-day range and reads rollups. `groupBy=hour` always aggregates live
and is capped at **31 days**, returning 422 beyond it. A month answers the real question ("which
hours are busy?") with a bounded worst case of 744 buckets.

Bucketing is timezone-aware — `date_trunc('hour', created_at AT TIME ZONE :BUSINESS_TIMEZONE)`, not
naive UTC, for the same reason `businessDayOf` reads the zone through `Intl`: an hour label is a
wall-clock fact.

An `hourly_sales_rollups` table was rejected as YAGNI. Nothing asks for hourly-over-a-year, it
doubles this slice, and the open day would still need the live path regardless. The endpoint's
contract does not change if one is added later.

### 3. The Z-report serves without a reconciliation block rather than failing

§5.3 embeds a gateway-versus-books delta. Two situations leave that delta untrustworthy: the day is
still trading (the delta is work in progress), or Stripe is unreachable — `reconcile()` throws in
the second case.

The report is still served. Revenue, refunds, VAT and the status counts are all correct without the
gateway, and they are what a manager actually cashes up against. But the block becomes an explicit
`null` with a stated reason, **never a fabricated zero delta**:

```json
"reconciliation": null,
"reconciliationUnavailable": "DAY_STILL_TRADING"
```

with `GATEWAY_UNREACHABLE` as the other value. This matches the reconciliation service's own
recorded stance: *"could not check"* and *"checked and it agrees"* are opposite facts, and a job
that conflates them is worse than one that does not run.

Failing the whole request was rejected: a Stripe outage would stop the shop closing its till, and it
would also fire on the open day, where the delta was never meaningful.

### 4. The five aggregate queries are extracted and shared

The rollup job already contains them. The read path needs the same aggregation for any day lacking a
rollup. Duplicating would leave two definitions of what a day totals — and the q4/q5 VAT fan-out
trap alone would have to be independently avoided a second time.

`aggregateDay(db, businessDay) → RollupParts` is extracted from `rollDay`. `rollDay` becomes guard +
`aggregateDay` + `buildRollupRow` + upsert. The read path calls `aggregateDay` + `buildRollupRow`
and writes nothing. A change to the `settled` predicate, or to the VAT/items split, now reaches both
callers or neither.

Having the reader call `rollDay` for unrolled closed days was rejected: it makes a GET perform a
write, races concurrent readers on the upsert, and cannot serve the open day at all because the
closed-day guard refuses it — so a live path is still needed and nothing is saved.

### 5. `orders_settled` is added to the rollup — migration `0006`

§5.2 requires avg ticket per bucket. The denominator must match the numerator: revenue counts every
order with a `SUCCEEDED` payment, so the order count must too. The rollup row stores status counts
(`completed` / `refunded` / `cancelled` / `expired`) and none of them is that number — a paid order
sitting in `READY` at roll time is a sale, and a refunded order was a sale.

One additive integer column, `orders_settled`, counted with the same `settled` predicate revenue and
VAT already use. §7.2 already establishes the schema is extended additively; migrations `0001`–`0005`
did exactly this.

Using `orders_completed` as the denominator was rejected: it inflates the average by every order
that was refunded or still in flight at roll time, and the live path would have to replicate the
error to agree with history.

**Known consequence.** Rows already finalized keep `orders_settled = 0`, and the catch-up sweep will
not revisit them because they carry `finalized_at`. This is slice 1's deferred residual biting for
the first time, exactly where it was predicted to. No production rows exist, so the remedy is to
delete dev rows and let them re-roll. If this recurs on real data, it is the trigger to implement
the other candidate from slice 1: an unconditional re-roll of a trailing window.

## Design

### One type flows through both paths

```ts
dayTotals(businessDay: string): Promise<{ row: RollupRow; live: boolean }>
```

- a finalized rollup row exists → map the stored row into `RollupRow`
- otherwise → `buildRollupRow(businessDay, await aggregateDay(db, businessDay))`

Downstream shaping never learns which source a day came from. That is what makes drift structurally
hard rather than merely tested against — there is one shape and one set of rules for producing it.

Rolled days are fetched in **one** query for the whole range:

```sql
SELECT * FROM daily_sales_rollups
 WHERE business_day BETWEEN :from AND :to
   AND finalized_at IS NOT NULL
```

Only the gaps then cost a live aggregation — normally zero or one day.

**Missing rollups are capped at 31 days per request.** Beyond that the request fails with 503 naming
the count of missing days. A range needing 300 live days means the rollup job has been broken for
months; serving it slowly hides an operational fault that ought to be loud.

This bound governs the **`groupBy=day` stitching path only**, where a live day is the exception. It
must not be applied to `groupBy=hour`, which is live over its whole range by definition — a
31-day hourly query is at its own legitimate maximum, and running it through a
"too many live days" check would reject the largest valid request. The two limits happen to share a
number and govern different things: one bounds *how much of a stitched range is missing*, the other
bounds *how wide an hourly scan may be*.

### `GET /reports/sales?from&to&groupBy=day|hour`

Roles: ADMIN, MANAGER. `from` and `to` are business days (`YYYY-MM-DD`).

```json
{
  "from": "2026-06-01",
  "to": "2026-06-11",
  "groupBy": "day",
  "provisional": false,
  "buckets": [
    { "bucket": "2026-06-01", "revenueMinor": 412000, "ordersSettled": 84, "avgTicketMinor": 4905 }
  ]
}
```

`bucket` is `YYYY-MM-DD` for `day` and `YYYY-MM-DDTHH` in the business timezone for `hour`.

`avgTicketMinor` is `Math.round(revenueMinor / ordersSettled)`, and `null` when `ordersSettled` is 0.
This is the one division near money in the codebase, and it is allowed because an average ticket is
a derived statistic rather than an amount anyone pays. Every stored and transmitted money value
remains an integer minor unit.

### `GET /reports/top-items?from&to&limit=10`

Roles: ADMIN, MANAGER. `limit` defaults to 10, maximum 50.

```json
{
  "from": "2026-06-01", "to": "2026-06-11", "provisional": false,
  "items": [
    { "menuItemId": "0191…", "name": "Latte", "quantity": 842, "revenueMinor": 6300000 }
  ]
}
```

Entries are merged across days by `menuItemId`, summing quantity and revenue, then sorted by
quantity descending with name as the tiebreak, then limited.

Merging on id **closes a minor finding deferred from slice 1**: `top_items` is grouped by
`(menu_item_id, name_snapshot)`, so an item renamed mid-service appears as two entries within a
day. Rejoining on id makes that invisible to the caller. The display name is taken from the most
recent day in range that sold the item.

### `GET /reports/z-report?businessDay=2026-06-11`

Roles: ADMIN, MANAGER. §5.3's shape, plus `provisional` and the nullable reconciliation block from
decision 3. The reconciliation figures come from `ReconciliationService.reconcile(businessDay)`,
which slice 1 left public with a comment saying it exists so FR-20 can ask directly.

The open business day is permitted and flagged, consistent with decision 1. `rollDay`'s closed-day
guard is not involved — this path reads and never writes.

### Validation, access, caching

Zod DTOs via `createZodDto`, so malformed input is 422 per §5.4's status policy. `from ≤ to`; range
≤366 days for `day` and ≤31 for `hour`; `groupBy` an enum; `limit` 1–50. `from` and `to` are
business days in every case — `groupBy` changes the bucket granularity within the range, not the
units the range is expressed in.

`to` may not exceed the current business day (422). A range ending next week is a client bug, and
the alternative is aggregating days that have not happened to return guaranteed-zero buckets.

`@Roles('ADMIN', 'MANAGER')` on all three, matching §6.4's matrix row. Every route is declared in
`authz-matrix.e2e-spec.ts`, which introspects the real Express route table and has already caught an
undeclared route once in this repo.

All three carry `Cache-Control: no-store`. §11.4 puts reports-for-today in the not-cached column, and
there is no case yet for caching the rest.

## Testing

**Unit, no database** (`shape-reports.spec.ts`): bucket assembly; top-items merged across days,
including the rename split rejoining on id; `avgTicketMinor` rounding and its zero-denominator case;
the `provisional` rule; an empty range.

**E2E** (`reports-http.e2e-spec.ts`): RBAC — cashier and barista 403, manager 200; the `hour` cap
returning 422 past 31 days; a range spanning a rolled day, an unrolled closed day and the open day,
asserting the stitch and `provisional: true`; z-report with the gateway stubbed unreachable →
`reconciliation: null` and `GATEWAY_UNREACHABLE`; z-report on the open day → `provisional: true` and
`DAY_STILL_TRADING`; §17's exit criterion — a Z-report matching hand-computed totals over seeded
data.

**The test that carries the slice.** Seed a business day, read it through the live path, then roll
it, then read it again through the rollup path, and assert the two responses are identical. That is
the premise of the whole design: history and today agree because they are computed by the same code.
It will be falsified by making the two paths diverge deliberately and confirming it goes red — a
test that passes when the paths disagree would be worth nothing.

## Out of scope

- An `hourly_sales_rollups` table (decision 2).
- Re-rolling already-finalized days (slice 1's residual; `orders_settled` backfill is a dev-data
  delete, not a code path).
- Caching, and the read replica §11.2 lists as the next step after rollups.
- Email delivery of the Z-report — §12.4 lists it as out for v1.
