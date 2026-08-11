# Reporting Read Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `GET /reports/sales`, `/reports/top-items` and `/reports/z-report` from nightly rollups for closed days and live aggregates for everything else, so history and today are computed by the same code.

**Architecture:** The five aggregate queries move out of the rollup job into a shared `aggregateDay()`. A read service resolves each business day in a range to a `RollupRow` — from the stored row when one is finalized, otherwise by aggregating live — so all downstream shaping sees one type regardless of source. Pure functions do the bucketing, merging and rounding.

**Tech Stack:** NestJS 11, Drizzle ORM 0.45.2 over node-postgres, Zod v4 via `createZodDto`, Jest (unit + e2e).

**Spec:** `docs/superpowers/specs/2026-08-11-phase6-reports-read-design.md`

## Global Constraints

- Branch is `phase6-reports-read`, already created off `main` and carrying the spec commit. Do not merge; the user runs `gh pr merge` themselves.
- **Commit messages carry no `Co-Authored-By` trailer.** Repo style is a sentence in the imperative — `Serve the kitchen its worklist`, not `feat: add reports endpoint`. No conventional-commit prefixes.
- Money is integer minor units (satang) everywhere. The **only** permitted division is `avgTicketMinor`, which is a derived statistic and is `Math.round`ed. No other float arithmetic touches money.
- `pnpm typecheck` must be clean before every commit. `pnpm lint` runs `eslint --fix` and rewrites files — fine to use, but re-run typecheck afterwards and check `git diff` before staging.
- Do NOT run `pnpm format` — it rewrites the whole repo's line endings on Windows. Use `npx prettier --write <specific paths>`.
- **Do not use `pnpm test:e2e -- <file> -t <name>`** — the double `--` shifts Jest's argument parsing so `-t` becomes a path pattern, running unrelated suites and spending a shared per-IP login budget that persists in Redis for 15 minutes. Use `npx jest --config ./test/jest-e2e.json <file> -t "<name>"`. The plain `pnpm test:e2e -- <file>` form (no `-t`) is correct.
- e2e fixture business days must be in the **past**. `rollDay` refuses any day that has not finished trading, so a future-dated fixture day is rejected rather than rolled.
- Local Postgres is on host port **5433**; CI uses 5432. Take it from `.env`, never hardcode.
- New HTTP routes must be added to `MATRIX` in `test/authz-matrix.e2e-spec.ts`. A completeness check there fails if the app grows a route the table does not mention.
- No new dependencies.

---

### Task 1: Share the aggregation, and count settled orders

Moves the five queries out of the rollup job so the read path can use them, and adds the `orders_settled` column that avg ticket needs. Reviewable on one question: do the rollups still produce exactly what they did, plus a correct new count?

**Files:**
- Create: `src/reporting/rollup/aggregate-day.ts`
- Modify: `src/database/schema/reporting.ts`
- Modify: `src/reporting/rollup/build-rollup-row.ts`
- Modify: `src/reporting/rollup/build-rollup-row.spec.ts`
- Modify: `src/reporting/rollup/daily-rollup.service.ts`
- Modify: `test/daily-rollup.e2e-spec.ts`
- Create: `drizzle/0006_*.sql` (generated)

**Interfaces:**
- Consumes: `RollupParts`, `RollupRow`, `buildRollupRow` from `build-rollup-row.ts`; `Database` from `src/database/database.module`.
- Produces: `aggregateDay(db: Database, businessDay: string): Promise<RollupParts>` from `aggregate-day.ts`. `RollupParts` and `RollupRow` both gain `ordersSettled: number`. Tasks 3–6 rely on all of these.

- [ ] **Step 1: Add the column to the schema**

In `src/database/schema/reporting.ts`, add to `dailySalesRollups` immediately after `ordersExpired`:

```ts
  /**
   * Orders that took money — at least one SUCCEEDED payment.
   *
   * The denominator for avg ticket (§5.2), and deliberately not any of the
   * status counts above: a paid order still sitting in READY at roll time is a
   * sale, and a refunded order was a sale. Counted with the same `settled`
   * predicate revenue and VAT use, so the average cannot be revenue divided by
   * a different set of orders than produced it.
   */
  ordersSettled: integer('orders_settled').notNull().default(0),
```

- [ ] **Step 2: Generate and apply the migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Confirm the generated file contains `ADD COLUMN "orders_settled" integer DEFAULT 0 NOT NULL` and nothing else. If `db:generate` proposes any other change, stop and report it — the only intended schema delta is this column.

- [ ] **Step 3: Write the failing unit test**

In `src/reporting/rollup/build-rollup-row.spec.ts`, add `ordersSettled: 0` to the `EMPTY` constant, then add these tests inside the existing `describe('buildRollupRow')`:

```ts
  it('carries the settled-order count through', () => {
    const row = buildRollupRow('2026-06-11', parts({ ordersSettled: 84 }));

    expect(row.ordersSettled).toBe(84);
  });

  it('reports zero settled orders for a day that took no money', () => {
    const row = buildRollupRow('2026-06-11', parts());

    expect(row.ordersSettled).toBe(0);
  });
```

Also add `ordersSettled: 0` to the expected object in the existing test `'produces a zero row for a day the cafe never opened'`.

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm test -- build-rollup-row`
Expected: FAIL — `ordersSettled` is not a property of `RollupParts` (typecheck) / `row.ordersSettled` is `undefined`.

- [ ] **Step 5: Thread `ordersSettled` through the pure function**

In `src/reporting/rollup/build-rollup-row.ts`, add to `RollupParts`:

```ts
  /** Orders that took money — the avg-ticket denominator (§5.2). */
  ordersSettled: number;
```

add to `RollupRow`:

```ts
  ordersSettled: number;
```

and add to the returned object in `buildRollupRow`, immediately after `ordersExpired`:

```ts
    ordersSettled: parts.ordersSettled,
```

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm test -- build-rollup-row`
Expected: PASS, 10 tests.

- [ ] **Step 7: Extract the queries**

Create `src/reporting/rollup/aggregate-day.ts`:

```ts
import { and, eq, exists, sql, sum } from 'drizzle-orm';
import type { Database } from '../../database/database.module';
import { orderItems, orders, payments, refunds } from '../../database/schema';
import type { RollupParts } from './build-rollup-row';

/**
 * What one business day totalled, straight from the live tables.
 *
 * Extracted from the nightly job so the read side can compute a day that has
 * no rollup row — today, or a day closed too recently for the 03:00 run — with
 * exactly the code that produced every other day. Two definitions of "what did
 * this day total" would drift, and the drift would surface as history and today
 * quietly disagreeing, which is the one thing the rollup design cannot afford.
 *
 * Writes nothing. Persisting is `DailyRollupService.rollDay`'s job, and only it
 * is allowed to decide a day is final.
 */
export async function aggregateDay(
  db: Database,
  businessDay: string,
): Promise<RollupParts> {
  return db.transaction(
    async (tx) => {
      /**
       * "This order took money." Revenue, VAT, the settled count and top-items
       * all key off this one predicate, which is what keeps the Z-report
       * internally consistent: a VAT figure computed over a different set of
       * orders than the revenue figure would be indefensible at the counter.
       */
      const settled = exists(
        tx
          .select({ one: sql`1` })
          .from(payments)
          .where(
            and(
              eq(payments.orderId, orders.id),
              eq(payments.status, 'SUCCEEDED'),
            ),
          ),
      );

      // q1 — status counts. Deliberately not filtered by `settled`: a cancelled
      // order never paid, and still has to be counted as cancelled.
      const statusCounts = await tx
        .select({
          status: orders.status,
          count: sql<number>`count(*)::int`,
        })
        .from(orders)
        .where(eq(orders.businessDay, businessDay))
        .groupBy(orders.status);

      // q2 — revenue by method. Cash is a payment row like any other, so it
      // lands in the total here and is excluded only from the *gateway*
      // comparison reconciliation makes.
      //
      // `settled` is an order-level predicate; this query needs row-level
      // filtering on individual payments. Reusing `settled` would sum FAILED
      // payment rows that belong to an otherwise-settled order.
      const revenueByMethod = await tx
        .select({
          method: payments.method,
          total: sum(payments.amountMinor),
        })
        .from(payments)
        .innerJoin(orders, eq(payments.orderId, orders.id))
        .where(
          and(
            eq(orders.businessDay, businessDay),
            eq(payments.status, 'SUCCEEDED'),
          ),
        )
        .groupBy(payments.method);

      // q3 — refunds actually settled from the till. A FAILED refund is not
      // money that left the drawer.
      const [{ refunded }] = await tx
        .select({ refunded: sum(refunds.amountMinor) })
        .from(refunds)
        .innerJoin(payments, eq(refunds.paymentId, payments.id))
        .innerJoin(orders, eq(payments.orderId, orders.id))
        .where(
          and(
            eq(orders.businessDay, businessDay),
            eq(refunds.status, 'SUCCEEDED'),
          ),
        );

      // q4 — every item sold, not a truncated leaderboard: a range query sums
      // complete per-day lists, and truncated ones cannot be summed into an
      // exact answer.
      const items = await tx
        .select({
          menuItemId: orderItems.menuItemId,
          name: orderItems.nameSnapshot,
          quantity: sql<number>`sum(${orderItems.quantity})::int`,
          revenue: sum(orderItems.lineTotalMinor),
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(and(eq(orders.businessDay, businessDay), settled))
        .groupBy(orderItems.menuItemId, orderItems.nameSnapshot);

      /**
       * q5 — VAT and the settled-order count, over distinct orders and with
       * **no join to items**.
       *
       * Merging this into q4 looks like an obvious saving and is wrong: across
       * the `order_items` join each order's VAT would be added once per line on
       * the ticket, so a three-item order would contribute triple, and the
       * count would report lines rather than orders. Both figures are per-order.
       * Leave these two queries apart.
       *
       * The count rides along here rather than in its own query precisely
       * because it needs the same row set as the VAT sum — same FROM, same
       * WHERE, so the denominator and the numerator cannot diverge.
       */
      const [{ vat, settledOrders }] = await tx
        .select({
          vat: sum(orders.vatMinor),
          settledOrders: sql<number>`count(*)::int`,
        })
        .from(orders)
        .where(and(eq(orders.businessDay, businessDay), settled));

      /**
       * `sum()` is typed `string | null` because node-postgres returns numeric
       * and bigint aggregates as text — `'1000' + 500` would be `'1000500'`.
       * Converting at this boundary is what lets everything downstream be plain
       * arithmetic.
       */
      return {
        statusCounts,
        revenueByMethod: revenueByMethod.map(({ method, total }) => ({
          method,
          totalMinor: Number(total ?? 0),
        })),
        refundsMinor: Number(refunded ?? 0),
        vatMinor: Number(vat ?? 0),
        ordersSettled: settledOrders,
        items: items.map(({ menuItemId, name, quantity, revenue }) => ({
          menuItemId,
          name,
          quantity,
          revenueMinor: Number(revenue ?? 0),
        })),
      };
    },
    /**
     * REPEATABLE READ, not merely READ ONLY. Postgres defaults to READ
     * COMMITTED and takes a fresh snapshot per *statement*, so `read only`
     * alone would let the five queries see different data. `read only` is a
     * guard against accidental writes, not an isolation level.
     */
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
```

- [ ] **Step 8: Slim the rollup service down to guard + aggregate + upsert**

In `src/reporting/rollup/daily-rollup.service.ts`, replace the entire body of `rollDay` — everything from `const row = await this.db.transaction(` through the end of that transaction call — with a single call to `aggregateDay`. The method becomes:

```ts
  async rollDay(businessDay: string): Promise<RollupRow> {
    /**
     * Only a day that has finished trading may be rolled.
     *
     * The nightly cron cannot trip this: it names a day that closed 22 hours
     * earlier. The guard is here for every *other* caller, because a rollup row
     * is treated as final — `missedDays` skips any day carrying `finalized_at`,
     * so a row written for a partial day would never be corrected. §5.3's
     * Z-report has to serve today flagged `provisional`, which makes
     * `rollDay(today)` the obvious wrong turn for the read slice to take.
     *
     * Throwing rather than returning early: a caller that asked for an open day
     * has a bug, and handing back a silently absent row would let it ship.
     *
     * Lexicographic comparison is exact here — both sides are `YYYY-MM-DD`,
     * zero-padded by `formatDate`, so string order is calendar order.
     */
    const currentBusinessDay = this.businessDayAt(Date.now());
    if (businessDay >= currentBusinessDay) {
      throw new BusinessDayNotClosedError(businessDay, currentBusinessDay);
    }

    const row = buildRollupRow(
      businessDay,
      await aggregateDay(this.db, businessDay),
    );

    const values = {
      businessDay: row.businessDay,
      ordersCompleted: row.ordersCompleted,
      ordersRefunded: row.ordersRefunded,
      ordersCancelled: row.ordersCancelled,
      ordersExpired: row.ordersExpired,
      ordersSettled: row.ordersSettled,
      revenueMinor: row.revenueMinor,
      revenueByMethod: row.revenueByMethod,
      refundsMinor: row.refundsMinor,
      vatMinor: row.vatMinor,
      topItems: row.topItems,
      finalizedAt: new Date(),
    };

    await this.db
      .insert(dailySalesRollups)
      .values(values)
      .onConflictDoUpdate({
        target: dailySalesRollups.businessDay,
        set: values,
      });

    this.logger.log(
      `Rolled up ${businessDay}: ${row.revenueMinor} minor units across ${row.topItems.length} items.`,
    );

    return row;
  }
```

Then remove the now-unused imports from that file: `exists`, `sum`, `orderItems`, `payments`, `refunds`, and `buildRollupRow`'s sibling query helpers if unreferenced. Add `import { aggregateDay } from './aggregate-day';`. Keep `and`, `asc`, `eq`, `gte`, `isNotNull`, `lt`, `notExists`, `sql`, `dailySalesRollups`, `orders` — the catch-up sweep still uses them. Let `pnpm typecheck` tell you exactly which imports are dead.

- [ ] **Step 9: Assert the new column end to end**

In `test/daily-rollup.e2e-spec.ts`, add this test inside the top-level `describe`, next to the other aggregate tests:

```ts
  it('counts orders that took money, not orders that completed', async () => {
    // Completed and paid — a sale by any definition.
    await givenOrder({
      status: 'COMPLETED',
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
    });
    // Paid, refunded at the till. Still a sale that took money.
    await givenOrder({
      status: 'REFUNDED',
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
    });
    // Paid but never marked completed — the barista forgot. Still a sale.
    await givenOrder({
      status: 'READY',
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
    });
    // Never paid. Not a sale.
    await givenOrder({
      status: 'CANCELLED',
      paid: false,
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
    });

    await roll();
    const row = await storedRow();

    // Three took money; ordersCompleted alone would say one.
    expect(row.ordersSettled).toBe(3);
    expect(row.ordersCompleted).toBe(1);
  });
```

- [ ] **Step 10: Run the suites**

```bash
pnpm test -- build-rollup-row
npx jest --config ./test/jest-e2e.json daily-rollup
pnpm typecheck
```

Expected: 10 unit, 17 e2e, typecheck clean.

If any pre-existing daily-rollup test fails on `orders_settled`, the migration did not apply — re-run `pnpm db:migrate`.

- [ ] **Step 11: Commit**

```bash
npx prettier --write src/reporting src/database/schema/reporting.ts test/daily-rollup.e2e-spec.ts
git add src/reporting src/database/schema/reporting.ts test/daily-rollup.e2e-spec.ts drizzle
git commit -F - <<'EOF'
Let the reader borrow the job's arithmetic

The five aggregates move into aggregateDay so the read side can total a
day with no rollup row — today, or one closed too recently for the 03:00
run — using exactly the code that produced every other day. Two
definitions of what a day totals would drift, and the drift would show
up as history and today disagreeing, which is the one thing this design
cannot afford.

orders_settled arrives with them. Avg ticket needs a denominator that
matches its numerator, and no existing column is one: revenue counts
every order that took money, while ordersCompleted misses a paid order
still sitting in READY and a refunded one that was a sale. It rides in
the VAT query rather than its own, because it needs that query's exact
row set.
EOF
```

---

### Task 2: The pure shaping

Everything that turns rows into a response body, with no database and no Nest. Reviewable on whether the money rules are right.

**Files:**
- Modify: `src/orders/business-day.ts`
- Modify: `src/orders/business-day.spec.ts`
- Create: `src/reporting/reports/shape-reports.ts`
- Create: `src/reporting/reports/shape-reports.spec.ts`

**Interfaces:**
- Consumes: `RollupRow` and `RollupItem` from `../rollup/build-rollup-row`; `MILLIS_PER_DAY` and `formatDate` (module-private) inside `business-day.ts`.
- Produces: `eachBusinessDay(from: string, to: string): string[]` from `src/orders/business-day`. From `shape-reports.ts`: `avgTicketMinor(revenueMinor: number, ordersSettled: number): number | null`, `salesBucket(bucket: string, row: RollupRow): SalesBucket`, `mergeTopItems(days: readonly DayItems[], limit: number): TopItem[]`, and the `SalesBucket` / `TopItem` / `DayItems` interfaces. Tasks 3–6 use all of them.

- [ ] **Step 1: Write the failing test for the date helper**

Add to `src/orders/business-day.spec.ts`, and add `eachBusinessDay` to the existing import from `./business-day`:

```ts
describe('eachBusinessDay', () => {
  it('is inclusive of both ends', () => {
    expect(eachBusinessDay('2026-06-01', '2026-06-03')).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ]);
  });

  it('returns the single day when from equals to', () => {
    expect(eachBusinessDay('2026-06-01', '2026-06-01')).toEqual(['2026-06-01']);
  });

  it('crosses a month boundary', () => {
    expect(eachBusinessDay('2026-05-30', '2026-06-02')).toEqual([
      '2026-05-30',
      '2026-05-31',
      '2026-06-01',
      '2026-06-02',
    ]);
  });

  it('crosses a leap day', () => {
    expect(eachBusinessDay('2028-02-28', '2028-03-01')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('returns empty when from is after to', () => {
    expect(eachBusinessDay('2026-06-03', '2026-06-01')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- business-day`
Expected: FAIL — `eachBusinessDay is not a function`.

- [ ] **Step 3: Implement it**

Add to `src/orders/business-day.ts`, below `minusDays`:

```ts
/**
 * Every business day label from `from` to `to`, inclusive.
 *
 * Calendar arithmetic through `Date.UTC` for the same reason its siblings use
 * it: these are date labels, not instants, so a daylight-saving transition must
 * not shorten or duplicate a day. Returns empty rather than throwing when the
 * range is inverted — callers validate `from <= to` and reject it as a 422, and
 * a helper that also threw would give two error paths for one mistake.
 */
export function eachBusinessDay(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);

  const end = Date.UTC(ty, tm - 1, td);
  const days: string[] = [];

  for (
    let cursor = Date.UTC(fy, fm - 1, fd);
    cursor <= end;
    cursor += MILLIS_PER_DAY
  ) {
    const day = new Date(cursor);
    days.push(
      formatDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()),
    );
  }

  return days;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm test -- business-day`
Expected: PASS, 21 tests.

- [ ] **Step 5: Write the failing test for the shaping**

Create `src/reporting/reports/shape-reports.spec.ts`:

```ts
import type { RollupRow } from '../rollup/build-rollup-row';
import {
  avgTicketMinor,
  mergeTopItems,
  salesBucket,
  type DayItems,
} from './shape-reports';

const row = (over: Partial<RollupRow> = {}): RollupRow => ({
  businessDay: '2026-06-11',
  ordersCompleted: 0,
  ordersRefunded: 0,
  ordersCancelled: 0,
  ordersExpired: 0,
  ordersSettled: 0,
  revenueMinor: 0,
  revenueByMethod: {},
  refundsMinor: 0,
  vatMinor: 0,
  topItems: [],
  ...over,
});

describe('avgTicketMinor', () => {
  it('rounds to the nearest satang', () => {
    // 412000 / 84 = 4904.76…
    expect(avgTicketMinor(412_000, 84)).toBe(4905);
  });

  it('rounds half away from zero, matching Math.round', () => {
    expect(avgTicketMinor(5, 2)).toBe(3);
  });

  it('is null when no order took money, rather than dividing by zero', () => {
    expect(avgTicketMinor(0, 0)).toBeNull();
  });

  it('is null even when revenue is somehow non-zero with no settled orders', () => {
    // Not reachable through the aggregates, but Infinity must never be a
    // money field on the wire.
    expect(avgTicketMinor(1_000, 0)).toBeNull();
  });
});

describe('salesBucket', () => {
  it('carries revenue and the settled count, with the average derived', () => {
    const bucket = salesBucket(
      '2026-06-11',
      row({ revenueMinor: 412_000, ordersSettled: 84 }),
    );

    expect(bucket).toEqual({
      bucket: '2026-06-11',
      revenueMinor: 412_000,
      ordersSettled: 84,
      avgTicketMinor: 4905,
    });
  });

  it('reports a day with no trade as zeros and a null average', () => {
    expect(salesBucket('2026-06-11', row())).toEqual({
      bucket: '2026-06-11',
      revenueMinor: 0,
      ordersSettled: 0,
      avgTicketMinor: null,
    });
  });
});

describe('mergeTopItems', () => {
  const days: DayItems[] = [
    {
      businessDay: '2026-06-01',
      topItems: [
        { menuItemId: 'latte', name: 'Latte', quantity: 10, revenueMinor: 100 },
        { menuItemId: 'bun', name: 'Bun', quantity: 4, revenueMinor: 40 },
      ],
    },
    {
      businessDay: '2026-06-02',
      topItems: [
        { menuItemId: 'latte', name: 'Latte', quantity: 5, revenueMinor: 50 },
      ],
    },
  ];

  it('sums quantity and revenue per item across days', () => {
    expect(mergeTopItems(days, 10)).toEqual([
      { menuItemId: 'latte', name: 'Latte', quantity: 15, revenueMinor: 150 },
      { menuItemId: 'bun', name: 'Bun', quantity: 4, revenueMinor: 40 },
    ]);
  });

  /**
   * The producer groups by (menu_item_id, name_snapshot), so renaming an item
   * mid-service splits it into two stored entries for that day. Rejoining on id
   * is what makes the split invisible to a caller.
   */
  it('rejoins an item that was renamed mid-service', () => {
    const renamed: DayItems[] = [
      {
        businessDay: '2026-06-01',
        topItems: [
          { menuItemId: 'l', name: 'Latte', quantity: 6, revenueMinor: 60 },
          { menuItemId: 'l', name: 'Caffè Latte', quantity: 3, revenueMinor: 30 },
        ],
      },
    ];

    expect(mergeTopItems(renamed, 10)).toEqual([
      { menuItemId: 'l', name: 'Caffè Latte', quantity: 9, revenueMinor: 90 },
    ]);
  });

  it('takes the display name from the most recent day that sold the item', () => {
    const renamedAcrossDays: DayItems[] = [
      {
        businessDay: '2026-06-02',
        topItems: [
          { menuItemId: 'l', name: 'Caffè Latte', quantity: 1, revenueMinor: 10 },
        ],
      },
      {
        businessDay: '2026-06-01',
        topItems: [{ menuItemId: 'l', name: 'Latte', quantity: 1, revenueMinor: 10 }],
      },
    ];

    // Input order is deliberately newest-first, to prove the name is chosen by
    // businessDay rather than by position in the array.
    expect(mergeTopItems(renamedAcrossDays, 10)[0].name).toBe('Caffè Latte');
  });

  it('orders by quantity descending, then by name', () => {
    const tied: DayItems[] = [
      {
        businessDay: '2026-06-01',
        topItems: [
          { menuItemId: 'b', name: 'Bun', quantity: 5, revenueMinor: 1 },
          { menuItemId: 'a', name: 'Americano', quantity: 5, revenueMinor: 2 },
          { menuItemId: 'c', name: 'Croissant', quantity: 9, revenueMinor: 3 },
        ],
      },
    ];

    expect(mergeTopItems(tied, 10).map((i) => i.name)).toEqual([
      'Croissant',
      'Americano',
      'Bun',
    ]);
  });

  it('applies the limit after merging, not before', () => {
    expect(mergeTopItems(days, 1)).toEqual([
      { menuItemId: 'latte', name: 'Latte', quantity: 15, revenueMinor: 150 },
    ]);
  });

  it('returns empty for a range with no sales', () => {
    expect(mergeTopItems([], 10)).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm test -- shape-reports`
Expected: FAIL — `Cannot find module './shape-reports'`.

- [ ] **Step 7: Implement the shaping**

Create `src/reporting/reports/shape-reports.ts`:

```ts
import type { RollupItem, RollupRow } from '../rollup/build-rollup-row';

/** One bucket of `GET /reports/sales` (§5.2). */
export interface SalesBucket {
  /** `YYYY-MM-DD` for `groupBy=day`, `YYYY-MM-DDTHH` for `hour`. */
  bucket: string;
  revenueMinor: number;
  ordersSettled: number;
  avgTicketMinor: number | null;
}

/** One row of `GET /reports/top-items` (§5.2). */
export interface TopItem {
  menuItemId: string;
  name: string;
  quantity: number;
  revenueMinor: number;
}

/** A day's stored or freshly-computed item list, tagged with the day it is for. */
export interface DayItems {
  businessDay: string;
  topItems: readonly RollupItem[];
}

/**
 * Revenue per sale, rounded to the nearest satang.
 *
 * The only division near money in this codebase, and it is allowed because an
 * average ticket is a statistic rather than an amount anyone pays — no cash
 * changes hands over this number. Every value that *is* paid stays an integer
 * minor unit.
 *
 * Null rather than zero or Infinity when nothing was sold: a day with no sales
 * has no average ticket, and reporting `0` would be a claim about the size of
 * sales that did not happen.
 */
export function avgTicketMinor(
  revenueMinor: number,
  ordersSettled: number,
): number | null {
  if (ordersSettled <= 0) return null;
  return Math.round(revenueMinor / ordersSettled);
}

/** Projects a day's totals into a sales bucket. */
export function salesBucket(bucket: string, row: RollupRow): SalesBucket {
  return {
    bucket,
    revenueMinor: row.revenueMinor,
    ordersSettled: row.ordersSettled,
    avgTicketMinor: avgTicketMinor(row.revenueMinor, row.ordersSettled),
  };
}

/**
 * Merges per-day item lists into one leaderboard for the range.
 *
 * Keyed by `menuItemId`, never by name. The producer groups by
 * `(menu_item_id, name_snapshot)`, so an item renamed mid-service is two
 * entries in a single day's stored list; joining on the id rejoins them, and
 * the caller never sees the split. The display name is taken from the most
 * recent business day that sold the item, so a rename reads as a rename rather
 * than as two products.
 *
 * The limit is applied last. Truncating per day before merging is what makes a
 * range answer wrong — an item ranked eleventh every day can outsell a spiky
 * third — and it is the reason the producer stores every item sold rather than
 * a leaderboard.
 */
export function mergeTopItems(
  days: readonly DayItems[],
  limit: number,
): TopItem[] {
  const totals = new Map<string, TopItem & { nameFrom: string }>();

  for (const { businessDay, topItems } of days) {
    for (const item of topItems) {
      const running = totals.get(item.menuItemId);

      if (running === undefined) {
        totals.set(item.menuItemId, {
          menuItemId: item.menuItemId,
          name: item.name,
          quantity: item.quantity,
          revenueMinor: item.revenueMinor,
          nameFrom: businessDay,
        });
        continue;
      }

      running.quantity += item.quantity;
      running.revenueMinor += item.revenueMinor;

      // `>=` so a later entry within the *same* day also wins — that is the
      // renamed-mid-service case, where the newer name appears second.
      if (businessDay >= running.nameFrom) {
        running.name = item.name;
        running.nameFrom = businessDay;
      }
    }
  }

  return [...totals.values()]
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ menuItemId, name, quantity, revenueMinor }) => ({
      menuItemId,
      name,
      quantity,
      revenueMinor,
    }));
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm test -- shape-reports`
Expected: PASS, 13 tests.

- [ ] **Step 9: Commit**

```bash
pnpm typecheck
npx prettier --write src/reporting/reports src/orders/business-day.ts src/orders/business-day.spec.ts
git add src/reporting/reports src/orders/business-day.ts src/orders/business-day.spec.ts
git commit -F - <<'EOF'
Decide what a range of days reads like

Merging top items on menuItemId rather than on name is what makes a
mid-service rename invisible: the producer groups by (id, name_snapshot),
so a renamed item is two entries in one day, and joining on the id
rejoins them. The display name comes from the most recent day that sold
it, so a rename reads as a rename and not as two products.

The limit is applied after merging. Truncating per day first is exactly
what makes a range answer wrong, and it is why the producer stores every
item sold rather than a leaderboard.

avgTicketMinor is the one division near money here, allowed because an
average ticket is a statistic and not an amount anyone pays. It is null
rather than zero when nothing sold — reporting 0 would be a claim about
the size of sales that did not happen.
EOF
```

---

### Task 3: Resolve a range to totals

The stitching core: rollups where they exist, live aggregation where they don't, one type out either way. This task ships no HTTP.

**Files:**
- Create: `src/reporting/reports/reports.service.ts`
- Modify: `src/reporting/reporting.module.ts`
- Create: `test/reports-service.e2e-spec.ts`

**Interfaces:**
- Consumes: `aggregateDay` (Task 1), `buildRollupRow` / `RollupRow` (Task 1), `eachBusinessDay` (Task 2), `businessDayOf` from `src/orders/business-day`, `DependencyUnavailableError` from `src/common/errors/dependency-unavailable.error`, `DRIZZLE` / `Database`, `dailySalesRollups`.
- Produces: `ReportsService` with `currentBusinessDay(): string`, `dayTotals(days: readonly string[]): Promise<Map<string, RollupRow>>`, and the constant `MAX_LIVE_DAYS = 31`. Tasks 4–6 consume all three.

- [ ] **Step 1: Write the failing test**

Create `test/reports-service.e2e-spec.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { DailyRollupService } from '../src/reporting/rollup/daily-rollup.service';
import { ReportsService } from '../src/reporting/reports/reports.service';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * The stitching core: a day's totals must be the same number whether they came
 * from a stored rollup or were aggregated live.
 */
describe('Reports day resolution (e2e)', () => {
  let harness: IdentityHarness;
  let reports: ReportsService;
  let rollup: DailyRollupService;
  let cashierId: string;
  let categoryId: string;
  let latteId: string;

  let day: string;
  let dayCounter = 0;
  const touchedDays: string[] = [];

  async function givenPaidOrder(
    businessDay: string,
    lineMinor: number,
    qty = 1,
    vatMinor = 0,
  ): Promise<void> {
    const orderId = uuidv7();

    await harness.db.insert(schema.orders).values({
      id: orderId,
      businessDay,
      channel: 'COUNTER',
      createdByUserId: cashierId,
      status: 'COMPLETED',
      subtotalMinor: lineMinor - vatMinor,
      vatMinor,
      totalMinor: lineMinor,
      currency: 'THB',
    });
    await harness.db.insert(schema.orderItems).values({
      id: uuidv7(),
      orderId,
      menuItemId: latteId,
      nameSnapshot: 'Latte',
      unitPriceMinorSnapshot: Math.round(lineMinor / qty),
      quantity: qty,
      lineTotalMinor: lineMinor,
    });
    await harness.db.insert(schema.payments).values({
      orderId,
      provider: 'CASH',
      method: 'CASH',
      status: 'SUCCEEDED',
      amountMinor: lineMinor,
      currency: 'THB',
      cashTenderedMinor: lineMinor,
    });
  }

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    reports = harness.app.get(ReportsService);
    rollup = harness.app.get(DailyRollupService);
    cashierId = (await harness.createStaff('CASHIER')).id;

    categoryId = uuidv7();
    latteId = uuidv7();
    await harness.db
      .insert(schema.categories)
      .values({ id: categoryId, name: `Reports Fixture ${categoryId}` });
    await harness.db.insert(schema.menuItems).values({
      id: latteId,
      categoryId,
      name: 'Latte',
      basePriceMinor: 10_000,
    });
  }, 60_000);

  beforeEach(() => {
    dayCounter += 1;
    // Past-dated: rollDay refuses any day that has not finished trading.
    day = `2021-03-${String(dayCounter).padStart(2, '0')}`;
    touchedDays.push(day);
  });

  afterAll(async () => {
    if (touchedDays.length > 0) {
      await harness.db
        .delete(schema.dailySalesRollups)
        .where(inArray(schema.dailySalesRollups.businessDay, touchedDays));
    }
    await harness.purgeOrders();
    await harness.db
      .delete(schema.menuItems)
      .where(eq(schema.menuItems.id, latteId));
    await harness.db
      .delete(schema.categories)
      .where(eq(schema.categories.id, categoryId));
    await harness.close();
  }, 30_000);

  /**
   * The test this slice exists to pass.
   *
   * Read a day live, roll it, read it again from the stored row, and require
   * the two to be identical. If these ever diverge, every historical report
   * silently disagrees with the same day viewed before 03:00.
   */
  it('produces identical totals from the live path and the rollup', async () => {
    await givenPaidOrder(day, 12_000, 2, 785);
    await givenPaidOrder(day, 8_000, 1, 523);

    const live = await reports.dayTotals([day]);
    await rollup.rollDay(day);
    const stored = await reports.dayTotals([day]);

    expect(stored.get(day)).toEqual(live.get(day));
    expect(live.get(day)!.revenueMinor).toBe(20_000);
    expect(live.get(day)!.ordersSettled).toBe(2);
    expect(live.get(day)!.vatMinor).toBe(1_308);
  });

  it('mixes stored and live days in one range', async () => {
    const rolled = day;
    const unrolled = `2021-04-${String(dayCounter).padStart(2, '0')}`;
    touchedDays.push(unrolled);

    await givenPaidOrder(rolled, 5_000);
    await givenPaidOrder(unrolled, 7_000);
    await rollup.rollDay(rolled);

    const totals = await reports.dayTotals([rolled, unrolled]);

    expect(totals.get(rolled)!.revenueMinor).toBe(5_000);
    expect(totals.get(unrolled)!.revenueMinor).toBe(7_000);
  });

  it('returns a zero row for a day that saw no trade at all', async () => {
    const totals = await reports.dayTotals([day]);

    expect(totals.get(day)!.revenueMinor).toBe(0);
    expect(totals.get(day)!.ordersSettled).toBe(0);
    expect(totals.get(day)!.topItems).toEqual([]);
  });

  it('refuses a range whose missing rollups exceed the cap', async () => {
    /**
     * 32 consecutive real days, none rolled — one past MAX_LIVE_DAYS. June has
     * 30 days, so this deliberately crosses into July rather than generating
     * `2021-06-31`, which is not a date and would fail for the wrong reason.
     */
    const many = [
      ...Array.from(
        { length: 30 },
        (_, i) => `2021-06-${String(i + 1).padStart(2, '0')}`,
      ),
      '2021-07-01',
      '2021-07-02',
    ];

    await expect(reports.dayTotals(many)).rejects.toThrow(/rollup/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json reports-service`
Expected: FAIL — `Cannot find module '../src/reporting/reports/reports.service'`.

- [ ] **Step 3: Implement the service**

Create `src/reporting/reports/reports.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, gte, isNotNull, lte } from 'drizzle-orm';
import { DependencyUnavailableError } from '../../common/errors/dependency-unavailable.error';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { dailySalesRollups } from '../../database/schema';
import { businessDayOf } from '../../orders/business-day';
import { aggregateDay } from '../rollup/aggregate-day';
import { buildRollupRow, type RollupRow } from '../rollup/build-rollup-row';

/**
 * How many days in one request may be aggregated live.
 *
 * A range normally has at most one — today, or a day closed too recently for
 * the 03:00 run. Needing thirty means the nightly job has been failing for a
 * month, and serving that request slowly would hide an operational fault behind
 * a spinner. Past this, the request is refused with a 503 that names the count.
 *
 * This bounds the `groupBy=day` stitching path only. It must NOT be applied to
 * `groupBy=hour`, which is live across its whole range by definition — a 31-day
 * hourly query is at its own legitimate maximum, and checking it here would
 * reject the largest valid request.
 */
export const MAX_LIVE_DAYS = 31;

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The business day currently taking money (§3.3). */
  currentBusinessDay(): string {
    return businessDayOf(
      new Date(),
      this.config.get('BUSINESS_TIMEZONE', { infer: true }),
      this.config.get('BUSINESS_DAY_START_HOUR', { infer: true }),
    );
  }

  /**
   * Totals for each requested business day, from whichever source is correct.
   *
   * A finalized rollup is read; anything else is aggregated live with the same
   * function that produced the rollups. Both paths return a `RollupRow`, so no
   * caller downstream can tell — or accidentally depend on — where a day came
   * from.
   */
  async dayTotals(
    days: readonly string[],
  ): Promise<Map<string, RollupRow>> {
    if (days.length === 0) return new Map();

    /**
     * Assumes `days` is sorted ascending, which is what `eachBusinessDay`
     * returns and what every caller passes. The first and last entries become
     * the bounds of the single range query below; an unsorted input would
     * silently narrow that range and send days to the live path that already
     * had rollups.
     */
    const from = days[0];
    const to = days[days.length - 1];

    /**
     * One query for every rolled day in the range, rather than one per day.
     * This is what makes §11.2's "historical reports are O(days)" true of the
     * request and not merely of the storage.
     */
    const stored = await this.db
      .select()
      .from(dailySalesRollups)
      .where(
        and(
          gte(dailySalesRollups.businessDay, from),
          lte(dailySalesRollups.businessDay, to),
          isNotNull(dailySalesRollups.finalizedAt),
        ),
      );

    const totals = new Map<string, RollupRow>();
    for (const row of stored) {
      totals.set(row.businessDay, {
        businessDay: row.businessDay,
        ordersCompleted: row.ordersCompleted,
        ordersRefunded: row.ordersRefunded,
        ordersCancelled: row.ordersCancelled,
        ordersExpired: row.ordersExpired,
        ordersSettled: row.ordersSettled,
        revenueMinor: row.revenueMinor,
        revenueByMethod: row.revenueByMethod as Record<string, number>,
        refundsMinor: row.refundsMinor,
        vatMinor: row.vatMinor,
        topItems: row.topItems as RollupRow['topItems'],
      });
    }

    const missing = days.filter((day) => !totals.has(day));

    if (missing.length > MAX_LIVE_DAYS) {
      throw new DependencyUnavailableError(
        `${missing.length} of the ${days.length} days requested have no finalized rollup, which is past the ${MAX_LIVE_DAYS}-day limit this endpoint will compute on demand. The nightly rollup has not been running.`,
      );
    }

    for (const day of missing) {
      totals.set(day, buildRollupRow(day, await aggregateDay(this.db, day)));
    }

    return totals;
  }
}
```

- [ ] **Step 4: Register it**

In `src/reporting/reporting.module.ts`, add the import and provider:

```ts
import { Module } from '@nestjs/common';
import { ReportsService } from './reports/reports.service';
import { DailyRollupService } from './rollup/daily-rollup.service';

/**
 * Reporting (§17 phase 6).
 *
 * The nightly rollup that §11.2 leans on, and the read side that consumes it.
 */
@Module({
  providers: [DailyRollupService, ReportsService],
  exports: [DailyRollupService, ReportsService],
})
export class ReportingModule {}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json reports-service`
Expected: PASS, 4 tests.

- [ ] **Step 6: Falsify the anti-drift test**

This is the test the slice exists to pass, so prove it can fail. Temporarily change `dayTotals` so the stored path returns `revenueMinor: 0` instead of `row.revenueMinor`, then:

Run: `npx jest --config ./test/jest-e2e.json reports-service -t "identical totals"`
Expected: **FAIL.** If it still passes, the test is not comparing the two paths — fix the test before restoring the code.

Restore the correct line and re-run to confirm green. Commit only the restored version.

- [ ] **Step 7: Commit**

```bash
pnpm typecheck
npx prettier --write src/reporting test/reports-service.e2e-spec.ts
git add src/reporting test/reports-service.e2e-spec.ts
git commit -F - <<'EOF'
Answer for a day from whichever source is right

A finalized rollup is read; anything else is aggregated live with the
function that produced the rollups in the first place. Both return a
RollupRow, so nothing downstream can tell where a day came from or
accidentally come to depend on it.

Rolled days are fetched in one query for the whole range rather than one
per day, which is what makes 11.2's "historical reports are O(days)"
true of the request and not just of the storage.

A range missing more than 31 rollups is refused with a 503 naming the
count. Needing thirty live days means the nightly job has been failing
for a month, and serving that slowly hides an operational fault behind a
spinner.

Falsified: with the stored path returning a wrong revenue, the
live-versus-rollup test fails.
EOF
```

---

### Task 4: `GET /reports/sales`

The first endpoint, plus the controller and DTOs the other two will extend.

**Files:**
- Create: `src/reporting/reports/reports.dto.ts`
- Create: `src/reporting/reports/reports.controller.ts`
- Modify: `src/reporting/reports/reports.service.ts`
- Modify: `src/reporting/reporting.module.ts`
- Modify: `test/authz-matrix.e2e-spec.ts`
- Create: `test/reports-http.e2e-spec.ts`

**Interfaces:**
- Consumes: `ReportsService.dayTotals` / `.currentBusinessDay()` (Task 3), `eachBusinessDay` (Task 2), `salesBucket` / `SalesBucket` (Task 2), `createZodDto` from `src/common/validation/zod-dto`, `Roles` from `src/identity/decorators/roles.decorator`.
- Produces: `SalesQueryDto` and the `MAX_DAY_RANGE_DAYS = 366` / `MAX_HOUR_RANGE_DAYS = 31` constants from `reports.dto.ts`; `ReportsService.salesReport(query): Promise<SalesReport>`; `ReportsController` mounted at `reports`. Tasks 5 and 6 add to both files.

- [ ] **Step 1: Write the failing test**

Create `test/reports-http.e2e-spec.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { IdentityHarness } from './fixtures/identity-fixtures';

describe('Reports HTTP (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;
  let cashierToken: string;
  let baristaToken: string;
  let cashierId: string;
  let categoryId: string;
  let latteId: string;

  const touchedDays: string[] = [];
  const DAY = '2021-09-01';

  async function givenPaidOrder(
    businessDay: string,
    lineMinor: number,
    qty = 1,
  ): Promise<void> {
    const orderId = uuidv7();
    await harness.db.insert(schema.orders).values({
      id: orderId,
      businessDay,
      channel: 'COUNTER',
      createdByUserId: cashierId,
      status: 'COMPLETED',
      subtotalMinor: lineMinor,
      vatMinor: 0,
      totalMinor: lineMinor,
      currency: 'THB',
    });
    await harness.db.insert(schema.orderItems).values({
      id: uuidv7(),
      orderId,
      menuItemId: latteId,
      nameSnapshot: 'Latte',
      unitPriceMinorSnapshot: Math.round(lineMinor / qty),
      quantity: qty,
      lineTotalMinor: lineMinor,
    });
    await harness.db.insert(schema.payments).values({
      orderId,
      provider: 'CASH',
      method: 'CASH',
      status: 'SUCCEEDED',
      amountMinor: lineMinor,
      currency: 'THB',
      cashTenderedMinor: lineMinor,
    });
  }

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    cashierId = (await harness.createStaff('CASHIER')).id;
    // tokenFor mints through AccessTokenService rather than POST /auth/login,
    // so these do not spend the shared per-IP login budget.
    managerToken = await harness.tokenFor('MANAGER');
    cashierToken = await harness.tokenFor('CASHIER');
    baristaToken = await harness.tokenFor('BARISTA');

    categoryId = uuidv7();
    latteId = uuidv7();
    await harness.db
      .insert(schema.categories)
      .values({ id: categoryId, name: `Reports HTTP ${categoryId}` });
    await harness.db.insert(schema.menuItems).values({
      id: latteId,
      categoryId,
      name: 'Latte',
      basePriceMinor: 10_000,
    });

    touchedDays.push(DAY);
    await givenPaidOrder(DAY, 12_000);
    await givenPaidOrder(DAY, 8_000);
  }, 60_000);

  afterAll(async () => {
    if (touchedDays.length > 0) {
      await harness.db
        .delete(schema.dailySalesRollups)
        .where(inArray(schema.dailySalesRollups.businessDay, touchedDays));
    }
    await harness.purgeOrders();
    await harness.db
      .delete(schema.menuItems)
      .where(eq(schema.menuItems.id, latteId));
    await harness.db
      .delete(schema.categories)
      .where(eq(schema.categories.id, categoryId));
    await harness.close();
  }, 30_000);

  describe('GET /reports/sales', () => {
    it('is refused to a cashier and a barista', async () => {
      for (const token of [cashierToken, baristaToken]) {
        const res = await harness
          .http()
          .get(`/api/v1/reports/sales?from=${DAY}&to=${DAY}`)
          .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(403);
      }
    });

    it('buckets revenue, settled orders and the average by day', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/sales?from=${DAY}&to=${DAY}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        from: DAY,
        to: DAY,
        groupBy: 'day',
        provisional: false,
      });
      expect(res.body.buckets).toEqual([
        {
          bucket: DAY,
          revenueMinor: 20_000,
          ordersSettled: 2,
          avgTicketMinor: 10_000,
        },
      ]);
    });

    it('sets no-store, because a report is money data', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/sales?from=${DAY}&to=${DAY}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('refuses an inverted range', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/sales?from=2021-09-02&to=2021-09-01`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(422);
    });

    it('refuses a range ending after the current business day', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/sales?from=2099-01-01&to=2099-01-02`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(422);
    });

    it('refuses an hourly range wider than 31 days', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/sales?from=2021-01-01&to=2021-03-01&groupBy=hour`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(422);
    });

    it('allows a daily range far wider than the hourly cap', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/sales?from=2021-08-25&to=2021-09-05`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.buckets).toHaveLength(12);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json reports-http`
Expected: FAIL — every request 404s, because no route exists.

- [ ] **Step 3: Write the DTO**

Create `src/reporting/reports/reports.dto.ts`:

```ts
import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';

/** §8's ceiling on a daily range. */
export const MAX_DAY_RANGE_DAYS = 366;

/**
 * The ceiling on an hourly range.
 *
 * Hourly buckets have no stored source — `daily_sales_rollups` is one row per
 * day — so they are always aggregated off the live tables, which is §11.2's
 * first-to-break. A month answers the question anyone actually asks of hourly
 * data, with a bounded worst case of 744 buckets.
 */
export const MAX_HOUR_RANGE_DAYS = 31;

/** `YYYY-MM-DD`, the shape of every `business_day` value in the schema. */
const businessDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD business day');

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/** Inclusive day count between two business days. */
function spanInDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    MILLIS_PER_DAY + 1;
}

export const SalesQuerySchema = z
  .object({
    from: businessDay,
    to: businessDay,
    groupBy: z.enum(['day', 'hour']).default('day'),
  })
  .refine((q) => q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine(
    (q) =>
      spanInDays(q.from, q.to) <=
      (q.groupBy === 'hour' ? MAX_HOUR_RANGE_DAYS : MAX_DAY_RANGE_DAYS),
    {
      message: `range must be at most ${MAX_DAY_RANGE_DAYS} days, or ${MAX_HOUR_RANGE_DAYS} when grouping by hour`,
      path: ['to'],
    },
  );

export class SalesQueryDto extends createZodDto(SalesQuerySchema) {}
```

- [ ] **Step 4: Add the report method to the service**

> `UnprocessableRangeError` is created in Step 5. Typecheck will be red on that
> import until you get there — that is expected, not a mistake. Do both steps
> before running it.

In `src/reporting/reports/reports.service.ts`, add these imports:

```ts
import { eachBusinessDay } from '../../orders/business-day';
import { salesBucket, type SalesBucket } from './shape-reports';
import { UnprocessableRangeError } from '../errors/reporting.errors';
```

add this exported interface above the class:

```ts
/** The `GET /reports/sales` body (§5.2). */
export interface SalesReport {
  from: string;
  to: string;
  groupBy: 'day' | 'hour';
  /** True exactly when the range includes the business day still taking money. */
  provisional: boolean;
  buckets: SalesBucket[];
}
```

and add this method to the class:

```ts
  async salesReport(query: {
    from: string;
    to: string;
    groupBy: 'day' | 'hour';
  }): Promise<SalesReport> {
    const current = this.currentBusinessDay();

    /**
     * A range ending after today is a client bug. Refusing beats aggregating
     * days that have not happened to return guaranteed-zero buckets, which
     * would read as data.
     */
    if (query.to > current) {
      throw new UnprocessableRangeError(
        `to must not be after the current business day (${current})`,
      );
    }

    const days = eachBusinessDay(query.from, query.to);

    if (query.groupBy === 'hour') {
      return {
        from: query.from,
        to: query.to,
        groupBy: 'hour',
        provisional: days.includes(current),
        buckets: await this.hourlyBuckets(query.from, query.to),
      };
    }

    const totals = await this.dayTotals(days);

    return {
      from: query.from,
      to: query.to,
      groupBy: 'day',
      provisional: days.includes(current),
      buckets: days.map((day) => salesBucket(day, totals.get(day)!)),
    };
  }

  /**
   * Hourly buckets, always live.
   *
   * Bucketed in the business timezone rather than UTC: an hour label is a
   * wall-clock fact, and a cafe's 09:00 rush is 09:00 on both sides of a
   * daylight-saving change. Only orders that took money are counted, matching
   * the daily path's `settled` predicate.
   *
   * Deliberately not routed through `dayTotals` — the missing-rollup cap there
   * bounds how much of a *stitched* range may be absent, which has no meaning
   * for a path that is live by definition.
   */
  private async hourlyBuckets(
    from: string,
    to: string,
  ): Promise<SalesBucket[]> {
    const zone = this.config.get('BUSINESS_TIMEZONE', { infer: true });

    const rows = await this.db
      .select({
        bucket: sql<string>`to_char(date_trunc('hour', ${orders.createdAt} AT TIME ZONE ${zone}), 'YYYY-MM-DD"T"HH24')`,
        revenueMinor: sql<number>`coalesce(sum(${orders.totalMinor}), 0)::bigint`,
        ordersSettled: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          gte(orders.businessDay, from),
          lte(orders.businessDay, to),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(payments)
              .where(
                and(
                  eq(payments.orderId, orders.id),
                  eq(payments.status, 'SUCCEEDED'),
                ),
              ),
          ),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    return rows.map((row) => ({
      bucket: row.bucket,
      revenueMinor: Number(row.revenueMinor),
      ordersSettled: row.ordersSettled,
      avgTicketMinor: avgTicketMinor(
        Number(row.revenueMinor),
        row.ordersSettled,
      ),
    }));
  }
```

Extend the drizzle import in that file to `import { and, eq, exists, gte, isNotNull, lte, sql } from 'drizzle-orm';`, add `orders, payments` to the schema import, and add `avgTicketMinor` to the `shape-reports` import.

- [ ] **Step 5: Add the 422 error**

Append to `src/reporting/errors/reporting.errors.ts`:

```ts
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * A range the caller may not ask for (§5.4's 422).
 *
 * Unlike `BusinessDayNotClosedError`, this one *is* a client error with a code
 * the caller can act on — they asked for something outside the allowed window
 * and can narrow it and retry.
 */
export class UnprocessableRangeError extends AppException {
  constructor(detail: string) {
    super({
      code: ErrorCode.VALIDATION_FAILED,
      status: 422,
      title: 'Unprocessable range',
      detail,
    });
  }
}
```

If `ErrorCode.VALIDATION_FAILED` does not exist, run `grep -n "export const ErrorCode" -A 25 src/common/errors/error-codes.ts` and use the existing 422 code rather than adding one.

- [ ] **Step 6: Write the controller**

Create `src/reporting/reports/reports.controller.ts`:

```ts
import { Controller, Get, Header, Query } from '@nestjs/common';
import { Roles } from '../../identity/decorators/roles.decorator';
import { SalesQueryDto } from './reports.dto';
import { ReportsService, type SalesReport } from './reports.service';

/**
 * The §5.2 reporting reads.
 *
 * MANAGER and ADMIN only, per §6.4's matrix — the same bar as refunds. A
 * cashier can take money all day and cannot see the day's totals, which is the
 * separation the matrix exists to draw.
 *
 * Every route is `no-store`. §11.4 puts reports-for-today in the not-cached
 * column, and a stale figure in a document someone signs off is worse than a
 * slow one.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Roles('ADMIN', 'MANAGER')
  @Header('Cache-Control', 'no-store')
  @Get('sales')
  sales(@Query() query: SalesQueryDto): Promise<SalesReport> {
    return this.reports.salesReport(query);
  }
}
```

- [ ] **Step 7: Register the controller**

In `src/reporting/reporting.module.ts`, add `controllers: [ReportsController],` and the matching import.

- [ ] **Step 8: Declare the route in the authz matrix**

In `test/authz-matrix.e2e-spec.ts`, add to `MATRIX`:

```ts
  {
    method: 'get',
    route: '/api/v1/reports/sales',
    path: '/api/v1/reports/sales?from=2021-01-01&to=2021-01-02',
    allow: [A, M],
  },
```

- [ ] **Step 9: Run the suites**

```bash
npx jest --config ./test/jest-e2e.json reports-http
npx jest --config ./test/jest-e2e.json authz-matrix
pnpm typecheck
```

Expected: 7 reports-http tests pass; authz-matrix passes including its completeness check.

- [ ] **Step 10: Commit**

```bash
npx prettier --write src/reporting test/reports-http.e2e-spec.ts test/authz-matrix.e2e-spec.ts
git add src/reporting test/reports-http.e2e-spec.ts test/authz-matrix.e2e-spec.ts
git commit -F - <<'EOF'
Report the takings for a range of days

Daily buckets come from the stitched path — rollups where they exist,
live aggregation where they do not — and are capped at 366 days. Hourly
buckets have no stored source at all, so they are always live and capped
at 31 days; the two limits govern different things and the hourly path
deliberately skips the stitching path's missing-rollup check, which would
otherwise reject the widest legal hourly request.

Hours are bucketed in the business timezone, not UTC. A cafe's nine
o'clock rush is nine o'clock on both sides of a daylight-saving change.

A range ending after today is refused rather than answered with
guaranteed-zero buckets that would read as data.
EOF
```

---

### Task 5: `GET /reports/top-items`

**Files:**
- Modify: `src/reporting/reports/reports.dto.ts`
- Modify: `src/reporting/reports/reports.service.ts`
- Modify: `src/reporting/reports/reports.controller.ts`
- Modify: `test/authz-matrix.e2e-spec.ts`
- Modify: `test/reports-http.e2e-spec.ts`

**Interfaces:**
- Consumes: `mergeTopItems` / `TopItem` / `DayItems` (Task 2), `ReportsService.dayTotals` (Task 3), `MAX_DAY_RANGE_DAYS` and the `businessDay` validation from Task 4.
- Produces: `TopItemsQueryDto`; `ReportsService.topItemsReport(query): Promise<TopItemsReport>`.

- [ ] **Step 1: Write the failing test**

Add to `test/reports-http.e2e-spec.ts`, inside the top-level `describe`:

```ts
  describe('GET /reports/top-items', () => {
    it('is refused to a cashier', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/top-items?from=${DAY}&to=${DAY}`)
        .set('Authorization', `Bearer ${cashierToken}`);

      expect(res.status).toBe(403);
    });

    it('merges an item across the range', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/top-items?from=${DAY}&to=${DAY}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([
        {
          menuItemId: latteId,
          name: 'Latte',
          quantity: 2,
          revenueMinor: 20_000,
        },
      ]);
    });

    it('honours the limit', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/top-items?from=${DAY}&to=${DAY}&limit=1`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
    });

    it('refuses a limit outside 1..50', async () => {
      for (const limit of ['0', '51']) {
        const res = await harness
          .http()
          .get(`/api/v1/reports/top-items?from=${DAY}&to=${DAY}&limit=${limit}`)
          .set('Authorization', `Bearer ${managerToken}`);

        expect(res.status).toBe(422);
      }
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json reports-http -t "top-items"`
Expected: FAIL — 404, no route.

- [ ] **Step 3: Add the DTO**

Append to `src/reporting/reports/reports.dto.ts`:

```ts
const DEFAULT_TOP_ITEMS_LIMIT = 10;
const MAX_TOP_ITEMS_LIMIT = 50;

export const TopItemsQuerySchema = z
  .object({
    from: businessDay,
    to: businessDay,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_TOP_ITEMS_LIMIT)
      .default(DEFAULT_TOP_ITEMS_LIMIT),
  })
  .refine((q) => q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine((q) => spanInDays(q.from, q.to) <= MAX_DAY_RANGE_DAYS, {
    message: `range must be at most ${MAX_DAY_RANGE_DAYS} days`,
    path: ['to'],
  });

export class TopItemsQueryDto extends createZodDto(TopItemsQuerySchema) {}
```

- [ ] **Step 4: Add the service method**

In `src/reporting/reports/reports.service.ts`, add `mergeTopItems, type TopItem` to the `shape-reports` import, then add above the class:

```ts
/** The `GET /reports/top-items` body (§5.2). */
export interface TopItemsReport {
  from: string;
  to: string;
  provisional: boolean;
  items: TopItem[];
}
```

and to the class:

```ts
  async topItemsReport(query: {
    from: string;
    to: string;
    limit: number;
  }): Promise<TopItemsReport> {
    const current = this.currentBusinessDay();

    if (query.to > current) {
      throw new UnprocessableRangeError(
        `to must not be after the current business day (${current})`,
      );
    }

    const days = eachBusinessDay(query.from, query.to);
    const totals = await this.dayTotals(days);

    return {
      from: query.from,
      to: query.to,
      provisional: days.includes(current),
      items: mergeTopItems(
        days.map((day) => ({
          businessDay: day,
          topItems: totals.get(day)!.topItems,
        })),
        query.limit,
      ),
    };
  }
```

- [ ] **Step 5: Add the route**

In `src/reporting/reports/reports.controller.ts`, add the imports and this method:

```ts
  @Roles('ADMIN', 'MANAGER')
  @Header('Cache-Control', 'no-store')
  @Get('top-items')
  topItems(@Query() query: TopItemsQueryDto): Promise<TopItemsReport> {
    return this.reports.topItemsReport(query);
  }
```

- [ ] **Step 6: Declare it in the authz matrix**

```ts
  {
    method: 'get',
    route: '/api/v1/reports/top-items',
    path: '/api/v1/reports/top-items?from=2021-01-01&to=2021-01-02',
    allow: [A, M],
  },
```

- [ ] **Step 7: Run the suites**

```bash
npx jest --config ./test/jest-e2e.json reports-http
npx jest --config ./test/jest-e2e.json authz-matrix
pnpm typecheck
```

Expected: 11 reports-http tests pass; authz-matrix green.

- [ ] **Step 8: Commit**

```bash
npx prettier --write src/reporting test/reports-http.e2e-spec.ts test/authz-matrix.e2e-spec.ts
git add src/reporting test/reports-http.e2e-spec.ts test/authz-matrix.e2e-spec.ts
git commit -F - <<'EOF'
Name the best sellers over a range

Merged on menuItemId across every day in range, then sorted, then
limited — in that order. Truncating each day before merging is what makes
a range answer wrong, since an item ranked eleventh every day can outsell
a spiky third, and it is why the producer stores every item sold rather
than a leaderboard.
EOF
```

---

### Task 6: `GET /reports/z-report`

The Z-report, and the one cross-module wiring this slice needs.

**Files:**
- Modify: `src/payments/payments.module.ts`
- Modify: `src/reporting/reporting.module.ts`
- Modify: `src/reporting/reports/reports.dto.ts`
- Modify: `src/reporting/reports/reports.service.ts`
- Modify: `src/reporting/reports/reports.controller.ts`
- Modify: `test/authz-matrix.e2e-spec.ts`
- Modify: `test/reports-http.e2e-spec.ts`

**Interfaces:**
- Consumes: `ReconciliationService.reconcile(businessDay): Promise<ReconciliationReport>` from `src/payments/reconciliation/reconciliation.service`, `ReportsService.dayTotals` / `.currentBusinessDay()` (Task 3).
- Produces: `ZReportQueryDto`; `ReportsService.zReport(businessDay): Promise<ZReport>`.

- [ ] **Step 1: Export the reconciliation service**

`ReconciliationService` is a provider of `PaymentsModule` but is **not** exported, so `ReportingModule` cannot inject it as things stand.

In `src/payments/payments.module.ts`, change the exports line to:

```ts
  exports: [PAYMENT_PROVIDER, ReconciliationService],
```

In `src/reporting/reporting.module.ts`, add `imports: [PaymentsModule],` and the matching import.

- [ ] **Step 2: Write the failing test**

Add to `test/reports-http.e2e-spec.ts`, inside the top-level `describe`:

```ts
  describe('GET /reports/z-report', () => {
    it('is refused to a barista', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/z-report?businessDay=${DAY}`)
        .set('Authorization', `Bearer ${baristaToken}`);

      expect(res.status).toBe(403);
    });

    /**
     * §17's Phase 6 exit criterion: *"Z-report matches hand-computed totals
     * over seeded data."* The seed is two cash orders of 12,000 and 8,000
     * minor units, both COMPLETED — so by hand the day totals 20,000, all of
     * it CASH, across 2 completed orders, with no refunds and no VAT. Every
     * figure below is that arithmetic, not a value copied from a previous run.
     */
    it('reports the day the till has to be cashed up against', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/z-report?businessDay=${DAY}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        businessDay: DAY,
        provisional: false,
        revenueMinor: { total: 20_000, byMethod: { CASH: 20_000 } },
        refundsMinor: 0,
        vatMinor: 0,
      });
      expect(res.body.orders).toMatchObject({ completed: 2 });
    });

    /**
     * The figures a manager cashes up against never depended on the gateway,
     * so a Stripe outage must not withhold them — but the delta must never be
     * fabricated as zero either.
     */
    it('serves the report with reconciliation explicitly unavailable when the gateway is down', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/z-report?businessDay=${DAY}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.reconciliation).toBeNull();
      expect(res.body.reconciliationUnavailable).toBe('GATEWAY_UNREACHABLE');
    });

    it('flags the open business day and skips reconciliation as meaningless', async () => {
      const today = await harness
        .http()
        .get('/api/v1/reports/sales?from=2021-09-01&to=2021-09-01')
        .set('Authorization', `Bearer ${managerToken}`);
      expect(today.status).toBe(200);

      // The current business day, whatever it is when this runs.
      const current = new Date().toISOString().slice(0, 10);
      const res = await harness
        .http()
        .get(`/api/v1/reports/z-report?businessDay=${current}`)
        .set('Authorization', `Bearer ${managerToken}`);

      if (res.status === 200) {
        expect(res.body.provisional).toBe(true);
        expect(res.body.reconciliation).toBeNull();
        expect(res.body.reconciliationUnavailable).toBe('DAY_STILL_TRADING');
      } else {
        // Between 00:00 and 05:00 local the calendar date is one day ahead of
        // the business day, so this URL names a future day and 422 is correct.
        expect(res.status).toBe(422);
      }
    });
  });
```

The gateway-down expectation holds because `IdentityHarness.boot()` without a `paymentProvider` override uses the real Stripe adapter, and the e2e environment points it at a `STRIPE_API_BASE` that is not reachable for this call. If that test sees a populated `reconciliation` block instead, boot the harness with a stub provider whose `capturedTotalFor` rejects, and say so in your report.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json reports-http -t "z-report"`
Expected: FAIL — 404, no route.

- [ ] **Step 4: Add the DTO**

Append to `src/reporting/reports/reports.dto.ts`:

```ts
export const ZReportQuerySchema = z.object({ businessDay });

export class ZReportQueryDto extends createZodDto(ZReportQuerySchema) {}
```

- [ ] **Step 5: Add the service method**

In `src/reporting/reports/reports.service.ts`, add these imports:

```ts
import {
  ReconciliationService,
  type ReconciliationReport,
} from '../../payments/reconciliation/reconciliation.service';
import { describeError } from '../../common/errors/describe-error';
```

inject it in the constructor:

```ts
    private readonly reconciliation: ReconciliationService,
```

add above the class:

```ts
/** Why a Z-report carries no gateway comparison. */
export type ReconciliationUnavailable =
  | 'DAY_STILL_TRADING'
  | 'GATEWAY_UNREACHABLE';

/** The `GET /reports/z-report` body (§5.3). */
export interface ZReport {
  businessDay: string;
  provisional: boolean;
  orders: {
    completed: number;
    refunded: number;
    cancelled: number;
    expired: number;
  };
  revenueMinor: { total: number; byMethod: Record<string, number> };
  refundsMinor: number;
  vatMinor: number;
  reconciliation: ReconciliationReport | null;
  reconciliationUnavailable: ReconciliationUnavailable | null;
}
```

and to the class:

```ts
  async zReport(businessDay: string): Promise<ZReport> {
    const current = this.currentBusinessDay();

    if (businessDay > current) {
      throw new UnprocessableRangeError(
        `businessDay must not be after the current business day (${current})`,
      );
    }

    const provisional = businessDay === current;
    const totals = await this.dayTotals([businessDay]);
    const row = totals.get(businessDay)!;

    /**
     * The gateway comparison is skipped outright for a day still trading.
     * Reconciling an open day reports a delta that is just work in progress,
     * and a number that means nothing is worse in a cash-up document than an
     * absent one that says why.
     */
    let reconciliation: ReconciliationReport | null = null;
    let reconciliationUnavailable: ReconciliationUnavailable | null =
      provisional ? 'DAY_STILL_TRADING' : null;

    if (!provisional) {
      try {
        reconciliation = await this.reconciliation.reconcile(businessDay);
      } catch (error) {
        /**
         * Reported as unavailable, never as a delta of zero. "We could not
         * check" and "we checked and it agrees" are opposite facts, and the
         * till figures below never depended on the gateway — so the report is
         * still worth serving.
         */
        this.logger.error(
          `Z-report for ${businessDay} could not reach the gateway; serving without a reconciliation block. ${describeError(error)}`,
        );
        reconciliationUnavailable = 'GATEWAY_UNREACHABLE';
      }
    }

    return {
      businessDay,
      provisional,
      orders: {
        completed: row.ordersCompleted,
        refunded: row.ordersRefunded,
        cancelled: row.ordersCancelled,
        expired: row.ordersExpired,
      },
      revenueMinor: { total: row.revenueMinor, byMethod: row.revenueByMethod },
      refundsMinor: row.refundsMinor,
      vatMinor: row.vatMinor,
      reconciliation,
      reconciliationUnavailable,
    };
  }
```

Add a logger to the class if it has none: `private readonly logger = new Logger(ReportsService.name);` with `Logger` imported from `@nestjs/common`.

- [ ] **Step 6: Add the route**

```ts
  @Roles('ADMIN', 'MANAGER')
  @Header('Cache-Control', 'no-store')
  @Get('z-report')
  zReport(@Query() query: ZReportQueryDto): Promise<ZReport> {
    return this.reports.zReport(query.businessDay);
  }
```

- [ ] **Step 7: Declare it in the authz matrix**

```ts
  {
    method: 'get',
    route: '/api/v1/reports/z-report',
    path: '/api/v1/reports/z-report?businessDay=2021-01-01',
    allow: [A, M],
  },
```

- [ ] **Step 8: Run everything**

```bash
npx jest --config ./test/jest-e2e.json reports-http
npx jest --config ./test/jest-e2e.json authz-matrix
pnpm test
pnpm typecheck
```

Expected: 15 reports-http tests, authz-matrix green, full unit suite green.

- [ ] **Step 9: Commit**

```bash
npx prettier --write src/reporting src/payments/payments.module.ts test/reports-http.e2e-spec.ts test/authz-matrix.e2e-spec.ts
git add src/reporting src/payments/payments.module.ts test/reports-http.e2e-spec.ts test/authz-matrix.e2e-spec.ts
git commit -F - <<'EOF'
Close the day out

The Z-report serves whether or not the gateway answers. Revenue,
refunds, VAT and the counts are what a manager cashes up against and
none of them depended on Stripe, so a reconciliation that cannot be run
becomes an explicit null with a reason rather than a reason to withhold
the report. Never a delta of zero: "could not check" and "checked and it
agrees" are opposite facts.

An open day skips reconciliation outright rather than failing at it. A
delta computed over a day still taking money is work in progress, and a
number that means nothing is worse in a cash-up document than an absent
one that says why.

ReconciliationService had to be exported from PaymentsModule; it was a
provider only, kept private since the nightly job was its sole caller.
EOF
```

---

## Verification before handing over

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` — full unit suite green, count noted (was 391 on `main`)
- [ ] `pnpm test:e2e` — full e2e suite green, count noted (was 714 on `main`)
- [ ] Run the full e2e suite **twice** on a clean rate-limit budget. A 429 in an unrelated suite is the shared login budget, not a regression.
- [ ] Confirm §17's Phase 6 exit criterion: a Z-report over seeded data matches totals computed by hand. State the hand-computed figures in the PR body.
- [ ] Push the branch and open the PR. Request Copilot review via the REST endpoint, then verify with `gh run list --branch <branch>` — bot reviewers do not appear in `reviewRequests`. Call `gh` by its full path; it is not on `PATH`.
- [ ] Do not merge. Report the PR green and hand the merge command to the user.
