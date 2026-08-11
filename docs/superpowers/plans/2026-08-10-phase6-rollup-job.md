# Nightly Sales Rollup Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `daily_sales_rollups` nightly so historical reports become O(days) instead of scanning live order tables.

**Architecture:** A Nest service runs at 03:00 Asia/Bangkok, targets the business day that closed 22 hours earlier, and also sweeps back 30 days for any day that has orders but no finalized rollup. Per day it runs five aggregate queries inside one `REPEATABLE READ` transaction, hands the parts to a pure assembly function, and upserts one row. No distributed lock: the day is closed and the recompute is deterministic, so two instances converge.

**Tech Stack:** NestJS 11, `@nestjs/schedule` (`@Cron`), Drizzle ORM 0.45.2 over node-postgres, Jest (unit + e2e).

**Spec:** `docs/superpowers/specs/2026-08-10-phase6-rollup-job-design.md`

## Global Constraints

- Branch is `phase6-reporting`, already created off `main`. Do not merge; the user runs `gh pr merge` themselves.
- **Commit messages carry no `Co-Authored-By` trailer.** Repo style is a sentence in the imperative — `Serve the kitchen its worklist`, not `feat: add worklist endpoint`. Do not use conventional-commit prefixes.
- Money is integer minor units (satang) everywhere. Never floats.
- `pnpm test` runs unit specs; `pnpm test:e2e` runs `test/*.e2e-spec.ts`. `pnpm typecheck` and `pnpm lint` must both be clean before every commit.
- `pnpm format` rewrites the whole repo's line endings on Windows. Use `npx prettier --write <specific paths>` instead.
- Local Postgres is on host port **5433**; CI uses 5432. Take it from `.env`, do not hardcode.
- The e2e suites share a per-IP login budget that persists in Redis for 15 minutes across runs. Use `harness.tokenFor(...)` rather than logging in, and expect stray 429s if you run the full e2e suite repeatedly.
- **Do not use `pnpm test:e2e -- daily-rollup -t <name>`** — the double `--` shifts Jest's argument parsing so `-t` becomes a path pattern instead of a name filter, running unrelated suites and spending the login budget. Use `npx jest --config ./test/jest-e2e.json daily-rollup -t "<name>"` instead. The plain form `pnpm test:e2e -- daily-rollup` (without `-t`) works correctly.
- No new dependencies. Everything needed is already installed.

---

### Task 1: The pure assembly function

Turns query results into the row. No database, no Nest, no I/O — so every money rule in it is unit-testable with plain objects. This is the repo's established habit for anything money-shaped (`priceOrder`, `businessDayOf`).

**Files:**
- Create: `src/reporting/rollup/build-rollup-row.ts`
- Create: `src/reporting/rollup/build-rollup-row.spec.ts`

**Interfaces:**
- Consumes: `OrderStatus` and `PaymentMethod` from `src/database/schema/enums.ts`.
- Produces: `buildRollupRow(businessDay: string, parts: RollupParts): RollupRow`, the `RollupParts` / `RollupRow` / `RollupItem` interfaces, and the `UNKNOWN_METHOD` constant. Task 2 consumes all of these.

- [ ] **Step 1: Write the failing test**

Create `src/reporting/rollup/build-rollup-row.spec.ts`:

```ts
import {
  buildRollupRow,
  UNKNOWN_METHOD,
  type RollupParts,
} from './build-rollup-row';

const EMPTY: RollupParts = {
  statusCounts: [],
  revenueByMethod: [],
  refundsMinor: 0,
  vatMinor: 0,
  items: [],
};

const parts = (over: Partial<RollupParts> = {}): RollupParts => ({
  ...EMPTY,
  ...over,
});

describe('buildRollupRow', () => {
  it('counts each terminal status into its own column', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        statusCounts: [
          { status: 'COMPLETED', count: 412 },
          { status: 'REFUNDED', count: 3 },
          { status: 'CANCELLED', count: 9 },
          { status: 'EXPIRED', count: 17 },
        ],
      }),
    );

    expect(row.ordersCompleted).toBe(412);
    expect(row.ordersRefunded).toBe(3);
    expect(row.ordersCancelled).toBe(9);
    expect(row.ordersExpired).toBe(17);
  });

  it('defaults a status that saw no orders to zero, not undefined', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({ statusCounts: [{ status: 'COMPLETED', count: 5 }] }),
    );

    expect(row.ordersCancelled).toBe(0);
    expect(row.ordersExpired).toBe(0);
    expect(row.ordersRefunded).toBe(0);
  });

  it('reproduces §5.3 worked example: cash is in the total', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        revenueByMethod: [
          { method: 'CARD', totalMinor: 2_100_000 },
          { method: 'PROMPTPAY', totalMinor: 2_300_000 },
          { method: 'CASH', totalMinor: 412_000 },
        ],
      }),
    );

    expect(row.revenueMinor).toBe(4_812_000);
    expect(row.revenueByMethod).toEqual({
      CARD: 2_100_000,
      PROMPTPAY: 2_300_000,
      CASH: 412_000,
    });
  });

  it('buckets an unresolved method under UNKNOWN rather than dropping it', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        revenueByMethod: [
          { method: 'CARD', totalMinor: 10_000 },
          { method: null, totalMinor: 1_500 },
        ],
      }),
    );

    expect(row.revenueByMethod[UNKNOWN_METHOD]).toBe(1_500);
    // The invariant the Z-report exists to guarantee.
    expect(row.revenueMinor).toBe(11_500);
  });

  it('keeps Σ by_method equal to revenue_minor for any input', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        revenueByMethod: [
          { method: 'CARD', totalMinor: 7 },
          { method: 'CASH', totalMinor: 11 },
          { method: null, totalMinor: 13 },
        ],
      }),
    );

    const summed = Object.values(row.revenueByMethod).reduce((a, b) => a + b, 0);
    expect(summed).toBe(row.revenueMinor);
  });

  it('orders items by quantity descending, then by name', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        items: [
          { menuItemId: 'c', name: 'Croissant', quantity: 12, revenueMinor: 1 },
          { menuItemId: 'a', name: 'Americano', quantity: 84, revenueMinor: 2 },
          { menuItemId: 'l', name: 'Latte', quantity: 84, revenueMinor: 3 },
        ],
      }),
    );

    expect(row.topItems.map((i) => i.name)).toEqual([
      'Americano',
      'Latte',
      'Croissant',
    ]);
  });

  it('produces a zero row for a day the cafe never opened', () => {
    const row = buildRollupRow('2026-06-11', parts());

    expect(row).toEqual({
      businessDay: '2026-06-11',
      ordersCompleted: 0,
      ordersRefunded: 0,
      ordersCancelled: 0,
      ordersExpired: 0,
      revenueMinor: 0,
      revenueByMethod: {},
      refundsMinor: 0,
      vatMinor: 0,
      topItems: [],
    });
  });

  it('carries an aggregate past int32, which is why the columns are bigint', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        revenueByMethod: [
          { method: 'CARD', totalMinor: 2_000_000_000 },
          { method: 'PROMPTPAY', totalMinor: 2_000_000_000 },
        ],
      }),
    );

    // 4e9 > 2_147_483_647. An int32 column would have thrown before here.
    expect(row.revenueMinor).toBe(4_000_000_000);
    expect(Number.isSafeInteger(row.revenueMinor)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- build-rollup-row`
Expected: FAIL — `Cannot find module './build-rollup-row'`.

- [ ] **Step 3: Write the implementation**

Create `src/reporting/rollup/build-rollup-row.ts`:

```ts
import type { OrderStatus, PaymentMethod } from '../../database/schema/enums';

/**
 * Where money whose rail could not be resolved is counted.
 *
 * `payments.method` is nullable (migration 0005) because the webhook fills it
 * and resolution is allowed to fail — the reconciliation service records that
 * a coffee is worth more than a label. That money is still revenue, so it needs
 * a bucket: dropping it would leave the method breakdown silently short of the
 * total it is supposed to account for, which is the one thing a Z-report exists
 * to prevent.
 */
export const UNKNOWN_METHOD = 'UNKNOWN';

/** One entry per menu item that sold on the day (§5.2 top-items). */
export interface RollupItem {
  menuItemId: string;
  name: string;
  quantity: number;
  revenueMinor: number;
}

/** The five queries' results, already converted to numbers. */
export interface RollupParts {
  statusCounts: readonly { status: OrderStatus; count: number }[];
  revenueByMethod: readonly {
    method: PaymentMethod | null;
    totalMinor: number;
  }[];
  refundsMinor: number;
  vatMinor: number;
  items: readonly RollupItem[];
}

/** One `daily_sales_rollups` row, ready to upsert. */
export interface RollupRow {
  businessDay: string;
  ordersCompleted: number;
  ordersRefunded: number;
  ordersCancelled: number;
  ordersExpired: number;
  revenueMinor: number;
  revenueByMethod: Record<string, number>;
  refundsMinor: number;
  vatMinor: number;
  topItems: RollupItem[];
}

/**
 * Assembles one finalized business day from its aggregate parts.
 *
 * Pure on purpose. Every rule that decides what a number means — which bucket
 * unresolved money lands in, what an absent status counts as, how the total
 * relates to its breakdown — lives here rather than in SQL, so it can be
 * exercised with plain objects and no database.
 */
export function buildRollupRow(
  businessDay: string,
  parts: RollupParts,
): RollupRow {
  const counts = new Map(
    parts.statusCounts.map(({ status, count }) => [status, count]),
  );

  const revenueByMethod: Record<string, number> = {};
  for (const { method, totalMinor } of parts.revenueByMethod) {
    const key = method ?? UNKNOWN_METHOD;
    revenueByMethod[key] = (revenueByMethod[key] ?? 0) + totalMinor;
  }

  /**
   * Summed from the buckets rather than queried separately, which is what makes
   * `Σ by_method === revenue_minor` true by construction. There is no assertion
   * here because there is no path by which it can be false.
   */
  const revenueMinor = Object.values(revenueByMethod).reduce(
    (total, amount) => total + amount,
    0,
  );

  /**
   * Sorted so two runs over the same closed day produce a byte-identical row —
   * which is what lets the idempotency test assert equality rather than
   * set-membership. Name breaks a quantity tie because `menuItemId` is a uuidv7
   * and would order by creation time, which is not a property of the day.
   */
  const topItems = [...parts.items].sort(
    (a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name),
  );

  return {
    businessDay,
    ordersCompleted: counts.get('COMPLETED') ?? 0,
    ordersRefunded: counts.get('REFUNDED') ?? 0,
    ordersCancelled: counts.get('CANCELLED') ?? 0,
    ordersExpired: counts.get('EXPIRED') ?? 0,
    revenueMinor,
    revenueByMethod,
    refundsMinor: parts.refundsMinor,
    vatMinor: parts.vatMinor,
    topItems,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- build-rollup-row`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck, lint, format, and commit**

```bash
pnpm typecheck
pnpm lint
npx prettier --write src/reporting/rollup/build-rollup-row.ts src/reporting/rollup/build-rollup-row.spec.ts
git add src/reporting/rollup/build-rollup-row.ts src/reporting/rollup/build-rollup-row.spec.ts
git commit -F - <<'EOF'
Decide what a day's numbers mean, without a database

The rules that turn aggregate rows into a rollup are all judgement calls
about money: unresolved rails go to an UNKNOWN bucket rather than being
dropped, an absent status counts as zero rather than undefined, and the
total is summed from the buckets so the breakdown cannot disagree with
it. Keeping them in a pure function is what makes them testable with
plain objects, the same reason priceOrder and businessDayOf are free
functions.
EOF
```

---

### Task 2: Roll one day

The service, its five queries, and the upsert — for a single named day. No schedule yet, so this task is reviewable purely on whether the numbers are right.

**Files:**
- Create: `src/reporting/rollup/daily-rollup.service.ts`
- Create: `src/reporting/reporting.module.ts`
- Modify: `src/app.module.ts` (add `ReportingModule` to imports)
- Create: `test/daily-rollup.e2e-spec.ts`

**Interfaces:**
- Consumes: `buildRollupRow`, `RollupParts`, `RollupRow` from Task 1. `DRIZZLE` / `Database` from `src/database/database.module`. Schema tables from `src/database/schema`.
- Produces: `DailyRollupService` with `async rollDay(businessDay: string): Promise<RollupRow>`. Tasks 3 and 4 call it.

- [ ] **Step 1: Write the failing test**

Create `test/daily-rollup.e2e-spec.ts`:

```ts
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import type { PaymentMethod } from '../src/database/schema/enums';
import { DailyRollupService } from '../src/reporting/rollup/daily-rollup.service';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * §11.2's nightly rollup, which every historical report will read instead of
 * scanning live tables.
 *
 * A synthetic business day per test rather than a shared one: the job sums
 * *everything* on a day, so tests sharing a day would accumulate into each
 * other's totals — which would be the job working correctly and the fixture
 * being wrong.
 */
describe('Daily sales rollup (e2e)', () => {
  let harness: IdentityHarness;
  let rollup: DailyRollupService;
  let cashierId: string;
  let categoryId: string;
  let latteId: string;
  let croissantId: string;

  let day: string;
  let dayCounter = 0;
  const orderIds: string[] = [];
  const rolledDays: string[] = [];

  /**
   * An order with its lines and (optionally) a successful payment.
   *
   * `vatMinor` is passed per order rather than derived, because the VAT
   * assertion below has to be computed by hand from the orders — deriving it
   * here from the same code under test would assert nothing.
   */
  async function givenOrder({
    status = 'COMPLETED',
    method = 'CARD',
    vatMinor = 0,
    lines = [],
    paid = true,
    businessDay = day,
  }: {
    status?: schema.OrderStatus;
    method?: PaymentMethod | null;
    vatMinor?: number;
    lines?: { itemId: string; name: string; qty: number; lineMinor: number }[];
    paid?: boolean;
    businessDay?: string;
  }): Promise<string> {
    const orderId = uuidv7();
    orderIds.push(orderId);

    const totalMinor = lines.reduce((sum, l) => sum + l.lineMinor, 0);

    await harness.db.insert(schema.orders).values({
      id: orderId,
      businessDay,
      channel: 'COUNTER',
      createdByUserId: cashierId,
      status,
      subtotalMinor: totalMinor - vatMinor,
      vatMinor,
      totalMinor,
      currency: 'THB',
    });

    for (const line of lines) {
      await harness.db.insert(schema.orderItems).values({
        id: uuidv7(),
        orderId,
        menuItemId: line.itemId,
        nameSnapshot: line.name,
        unitPriceMinorSnapshot: Math.round(line.lineMinor / line.qty),
        quantity: line.qty,
        lineTotalMinor: line.lineMinor,
      });
    }

    if (paid && totalMinor > 0) {
      await harness.db.insert(schema.payments).values({
        orderId,
        provider: method === 'CASH' ? 'CASH' : 'STRIPE',
        providerIntentId: method === 'CASH' ? null : `pi_rollup_${uuidv7()}`,
        method,
        status: 'SUCCEEDED',
        amountMinor: totalMinor,
        currency: 'THB',
        ...(method === 'CASH' ? { cashTenderedMinor: totalMinor } : {}),
      });
    }

    return orderId;
  }

  async function roll(target = day) {
    rolledDays.push(target);
    return rollup.rollDay(target);
  }

  async function storedRow(target = day) {
    const [row] = await harness.db
      .select()
      .from(schema.dailySalesRollups)
      .where(eq(schema.dailySalesRollups.businessDay, target));
    return row;
  }

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    rollup = harness.app.get(DailyRollupService);
    cashierId = (await harness.createStaff('CASHIER')).id;

    categoryId = uuidv7();
    latteId = uuidv7();
    croissantId = uuidv7();
    await harness.db
      .insert(schema.categories)
      .values({ id: categoryId, name: `Rollup Fixture ${categoryId}` });
    await harness.db.insert(schema.menuItems).values([
      { id: latteId, categoryId, name: 'Latte', basePriceMinor: 10_000 },
      { id: croissantId, categoryId, name: 'Croissant', basePriceMinor: 6_000 },
    ]);
  }, 60_000);

  beforeEach(() => {
    dayCounter += 1;
    day = `2031-01-${String(dayCounter).padStart(2, '0')}`;
  });

  afterAll(async () => {
    if (rolledDays.length > 0) {
      await harness.db
        .delete(schema.dailySalesRollups)
        .where(inArray(schema.dailySalesRollups.businessDay, rolledDays));
    }
    await harness.purgeOrders();
    await harness.db
      .delete(schema.menuItems)
      .where(inArray(schema.menuItems.id, [latteId, croissantId]));
    await harness.db
      .delete(schema.categories)
      .where(eq(schema.categories.id, categoryId));
    await harness.close();
  }, 30_000);

  it('counts each terminal status', async () => {
    await givenOrder({ status: 'COMPLETED', lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }] });
    await givenOrder({ status: 'REFUNDED', lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }] });
    await givenOrder({ status: 'CANCELLED', paid: false, lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }] });
    await givenOrder({ status: 'EXPIRED', paid: false, lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }] });

    await roll();
    const row = await storedRow();

    expect(row.ordersCompleted).toBe(1);
    expect(row.ordersRefunded).toBe(1);
    expect(row.ordersCancelled).toBe(1);
    expect(row.ordersExpired).toBe(1);
  });

  it('totals revenue by method, with cash included', async () => {
    await givenOrder({ method: 'CARD', lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 21_000 }] });
    await givenOrder({ method: 'PROMPTPAY', lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 23_000 }] });
    await givenOrder({ method: 'CASH', lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 4_120 }] });

    await roll();
    const row = await storedRow();

    expect(row.revenueByMethod).toEqual({
      CARD: 21_000,
      PROMPTPAY: 23_000,
      CASH: 4_120,
    });
    expect(row.revenueMinor).toBe(48_120);
  });

  it('buckets a payment whose method never resolved under UNKNOWN', async () => {
    await givenOrder({ method: 'CARD', lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }] });
    await givenOrder({ method: null, lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 1_500 }] });

    await roll();
    const row = await storedRow();

    expect(row.revenueByMethod).toEqual({ CARD: 10_000, UNKNOWN: 1_500 });
    expect(row.revenueMinor).toBe(11_500);
  });

  it('counts only settled refunds', async () => {
    const orderId = await givenOrder({ lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }] });
    const [payment] = await harness.db
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, orderId));

    await harness.db.insert(schema.refunds).values([
      { paymentId: payment.id, amountMinor: 2_150, status: 'SUCCEEDED', reason: 'Wrong size', initiatedByUserId: cashierId },
      { paymentId: payment.id, amountMinor: 999, status: 'FAILED', reason: 'Fat finger', initiatedByUserId: cashierId },
    ]);

    await roll();
    const row = await storedRow();

    expect(row.refundsMinor).toBe(2_150);
  });

  /**
   * The one shape that catches a VAT sum taken across the order_items join.
   * With one line per order the two are numerically identical; with three
   * lines a merged query reports triple.
   */
  it('sums VAT once per order, not once per line', async () => {
    await givenOrder({
      vatMinor: 700,
      lines: [
        { itemId: latteId, name: 'Latte', qty: 1, lineMinor: 4_000 },
        { itemId: croissantId, name: 'Croissant', qty: 1, lineMinor: 3_000 },
        { itemId: latteId, name: 'Latte', qty: 1, lineMinor: 3_700 },
      ],
    });
    await givenOrder({
      vatMinor: 300,
      lines: [{ itemId: croissantId, name: 'Croissant', qty: 1, lineMinor: 4_300 }],
    });

    await roll();
    const row = await storedRow();

    // By hand from the orders: 700 + 300. A per-line sum would give 2_400.
    expect(row.vatMinor).toBe(1_000);
  });

  it('records every item sold, merged and ordered by quantity', async () => {
    await givenOrder({
      lines: [
        { itemId: latteId, name: 'Latte', qty: 2, lineMinor: 20_000 },
        { itemId: croissantId, name: 'Croissant', qty: 5, lineMinor: 30_000 },
      ],
    });
    await givenOrder({
      lines: [{ itemId: latteId, name: 'Latte', qty: 9, lineMinor: 90_000 }],
    });

    await roll();
    const row = await storedRow();

    expect(row.topItems).toEqual([
      { menuItemId: latteId, name: 'Latte', quantity: 11, revenueMinor: 110_000 },
      { menuItemId: croissantId, name: 'Croissant', quantity: 5, revenueMinor: 30_000 },
    ]);
  });

  it('ignores orders that were never paid when counting revenue and items', async () => {
    await givenOrder({ status: 'CANCELLED', paid: false, vatMinor: 500, lines: [{ itemId: latteId, name: 'Latte', qty: 3, lineMinor: 30_000 }] });

    await roll();
    const row = await storedRow();

    expect(row.revenueMinor).toBe(0);
    expect(row.vatMinor).toBe(0);
    expect(row.topItems).toEqual([]);
    // The order still counts as cancelled — status counts do not need a payment.
    expect(row.ordersCancelled).toBe(1);
  });

  it('writes a zero row for a day the cafe never opened', async () => {
    await roll();
    const row = await storedRow();

    expect(row.revenueMinor).toBe(0);
    expect(row.topItems).toEqual([]);
    expect(row.finalizedAt).not.toBeNull();
  });

  it('is idempotent — a second run reproduces the row exactly', async () => {
    await givenOrder({
      vatMinor: 700,
      lines: [
        { itemId: latteId, name: 'Latte', qty: 2, lineMinor: 20_000 },
        { itemId: croissantId, name: 'Croissant', qty: 1, lineMinor: 6_000 },
      ],
    });

    await roll();
    const first = await storedRow();
    await roll();
    const second = await storedRow();

    // finalizedAt is expected to move; everything else must not.
    expect({ ...second, finalizedAt: null }).toEqual({
      ...first,
      finalizedAt: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:e2e -- daily-rollup`
Expected: FAIL — `Cannot find module '../src/reporting/rollup/daily-rollup.service'`.

- [ ] **Step 3: Write the service**

Create `src/reporting/rollup/daily-rollup.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, exists, sql, sum } from 'drizzle-orm';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import {
  dailySalesRollups,
  orderItems,
  orders,
  payments,
  refunds,
} from '../../database/schema';
import { buildRollupRow, type RollupRow } from './build-rollup-row';

/**
 * The §11.2 nightly rollup: one finalized row per business day, so historical
 * reports are O(days) instead of a growing scan over live order tables.
 */
@Injectable()
export class DailyRollupService {
  private readonly logger = new Logger(DailyRollupService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Recomputes one business day from live tables and upserts its row.
   *
   * Safe to call repeatedly. The day this runs against is closed — §3.3 freezes
   * its refunds and the caller only ever names a day that ended hours ago — so
   * the aggregation is deterministic and a second run reproduces the first.
   */
  async rollDay(businessDay: string): Promise<RollupRow> {
    const row = await this.db.transaction(
      async (tx) => {
        /**
         * "This order took money." Revenue, VAT and top-items all key off this
         * one predicate, which is what keeps the Z-report internally
         * consistent: a VAT figure computed over a different set of orders than
         * the revenue figure would be indefensible at the counter.
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

        // q1 — status counts. Deliberately not filtered by `settled`: a
        // cancelled order never paid, and still has to be counted as cancelled.
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

        // q4 — every item sold, not a truncated leaderboard: a range query
        // sums complete per-day lists, and truncated ones cannot be summed
        // into an exact answer.
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
         * q5 — VAT, over distinct orders and with **no join to items**.
         *
         * Merging this into q4 looks like an obvious saving and is wrong: across
         * the `order_items` join each order's VAT would be added once per line
         * on the ticket, so a three-item order would contribute triple. VAT is
         * a per-order figure. Leave these two queries apart.
         */
        const [{ vat }] = await tx
          .select({ vat: sum(orders.vatMinor) })
          .from(orders)
          .where(and(eq(orders.businessDay, businessDay), settled));

        /**
         * `sum()` is typed `string | null` because node-postgres returns
         * numeric and bigint aggregates as text — `'1000' + 500` would be
         * `'1000500'`. Converting at this boundary is what lets everything
         * downstream be plain arithmetic.
         */
        return buildRollupRow(businessDay, {
          statusCounts,
          revenueByMethod: revenueByMethod.map(({ method, total }) => ({
            method,
            totalMinor: Number(total ?? 0),
          })),
          refundsMinor: Number(refunded ?? 0),
          vatMinor: Number(vat ?? 0),
          items: items.map(({ menuItemId, name, quantity, revenue }) => ({
            menuItemId,
            name,
            quantity,
            revenueMinor: Number(revenue ?? 0),
          })),
        });
      },
      /**
       * REPEATABLE READ isolation pins all five queries to one snapshot. Postgres
       * defaults to READ COMMITTED, which re-snapshots per statement, so READ ONLY
       * alone guarantees nothing. The day is closed, so they could not disagree in
       * practice — the isolation level costs nothing and removes the need to reason
       * about snapshot consistency every time someone reads the code.
       */
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const values = {
      businessDay: row.businessDay,
      ordersCompleted: row.ordersCompleted,
      ordersRefunded: row.ordersRefunded,
      ordersCancelled: row.ordersCancelled,
      ordersExpired: row.ordersExpired,
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
}
```

- [ ] **Step 4: Create the module and wire it in**

Create `src/reporting/reporting.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { DailyRollupService } from './rollup/daily-rollup.service';

/**
 * Reporting (§17 phase 6).
 *
 * Producer only for now — the nightly rollup that §11.2 leans on. The
 * `/reports/*` read side lands in the next slice and joins this module.
 */
@Module({
  providers: [DailyRollupService],
  exports: [DailyRollupService],
})
export class ReportingModule {}
```

In `src/app.module.ts`, add the import alongside the other feature modules:

```ts
import { ReportingModule } from './reporting/reporting.module';
```

and add `ReportingModule` to the `imports` array, immediately after `PaymentsModule`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:e2e -- daily-rollup`
Expected: PASS, 9 tests.

If `sums VAT once per order` fails with `2400` instead of `1000`, q4 and q5 have been merged — separate them.

- [ ] **Step 6: Typecheck, lint, format, and commit**

```bash
pnpm typecheck
pnpm lint
npx prettier --write src/reporting src/app.module.ts test/daily-rollup.e2e-spec.ts
git add src/reporting src/app.module.ts test/daily-rollup.e2e-spec.ts
git commit -F - <<'EOF'
Roll one trading day into a single row

Five aggregates in one read-only transaction, then an upsert. Revenue,
VAT and top-items all key off the same "this order took money"
predicate, because a VAT figure computed over a different set of orders
than the revenue figure could not be defended at the counter.

VAT is its own query with no join to order_items. Across that join each
order's VAT is added once per line on the ticket, so a three-item order
contributes triple — the e2e seeds a three-line order precisely so the
merged version cannot pass.
EOF
```

---

### Task 3: Run it nightly

Adds the schedule and the target-day choice. Reviewable on one question: does it pick the right day?

**Files:**
- Modify: `src/reporting/rollup/daily-rollup.service.ts`
- Modify: `test/daily-rollup.e2e-spec.ts`

**Interfaces:**
- Consumes: `businessDayOf` from `src/orders/business-day`, `ConfigService<Env, true>`, `DailyRollupService.rollDay` from Task 2.
- Produces: `DailyRollupService.rollUpYesterday(): Promise<RollupSummary>` where `RollupSummary` is `{ rolled: number; failed: number }`. Task 4 extends this method.

- [ ] **Step 1: Write the failing test**

Add to `test/daily-rollup.e2e-spec.ts`, inside the top-level `describe`:

```ts
  describe('the nightly run', () => {
    /**
     * `Date.now` only, rather than `jest.useFakeTimers()`.
     *
     * The service reads the clock in exactly one place — `businessDayAt` — so
     * that is all this needs to control. Replacing the whole timer subsystem
     * would also fake `queueMicrotask` and `hrtime`, which the Postgres driver
     * runs on, and would turn a clock test into a driver test.
     */
    function pretendItIs(iso: string): void {
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse(iso));
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    /**
     * At 03:00 the current business day is still yesterday's — the boundary is
     * 05:00 — so `now - 24h` names a day that closed 22 hours earlier. Asserted
     * rather than assumed, because an off-by-one here would roll up a day that
     * is still taking money.
     */
    it('targets the business day that closed 22 hours ago', async () => {
      // 2031-02-03T03:00 in Asia/Bangkok (UTC+7) is 2031-02-02T20:00Z.
      pretendItIs('2031-02-02T20:00:00Z');

      const target = '2031-02-01';
      rolledDays.push(target);

      await givenOrder({
        businessDay: target,
        lines: [{ itemId: latteId, name: 'Latte', qty: 4, lineMinor: 40_000 }],
      });

      const summary = await rollup.rollUpYesterday();

      expect(summary.rolled).toBeGreaterThanOrEqual(1);
      expect(summary.failed).toBe(0);

      const row = await storedRow(target);
      expect(row).toBeDefined();
      expect(row.revenueMinor).toBe(40_000);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json daily-rollup -t "closed 22 hours ago"`
Expected: FAIL — `rollup.rollUpYesterday is not a function`.

- [ ] **Step 3: Add the schedule**

In `src/reporting/rollup/daily-rollup.service.ts`, extend the imports:

```ts
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { describeError } from '../../common/errors/describe-error';
import type { Env } from '../../config/env.validation';
import { businessDayOf } from '../../orders/business-day';
```

Change the constructor to take config as well:

```ts
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}
```

Add above `rollDay`:

```ts
/** What one nightly run did. */
export interface RollupSummary {
  rolled: number;
  failed: number;
}
```

(place the interface at module scope, above the `@Injectable()` class)

and add these members to the class:

```ts
  /**
   * 03:00 local, the same slot reconciliation uses and for the same reason:
   * §3.3's business day starts at 05:00, so by three in the morning the day
   * being rolled has been closed for 22 hours and the current one has not
   * begun.
   *
   * Two instances (§11.3) both run this and neither coordinates with the other.
   * The day is closed and §3.3 froze its refunds, so both compute identical
   * numbers and the upsert converges — §9.3's "jobs are idempotent" holding
   * without a distributed lock, exactly as the expiry sweep does. A double run
   * costs one duplicated aggregation inside the dead zone.
   *
   * The literal timezone duplicates the configurable `BUSINESS_TIMEZONE` (same
   * default) because a decorator is evaluated at class-definition time and
   * cannot read `ConfigService`. Reconciliation has the same shape.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'roll-up-yesterday',
    timeZone: 'Asia/Bangkok',
  })
  async rollUpYesterday(): Promise<RollupSummary> {
    const target = this.businessDayAt(Date.now() - 24 * 60 * 60 * 1000);
    return this.rollDays([target]);
  }

  /**
   * Rolls each day independently. One bad day must not cost the others theirs:
   * a failure here leaves that day without `finalized_at`, which is exactly the
   * condition the catch-up sweep looks for, so the retry is automatic.
   */
  private async rollDays(days: readonly string[]): Promise<RollupSummary> {
    let rolled = 0;
    let failed = 0;

    for (const day of days) {
      try {
        await this.rollDay(day);
        rolled += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Could not roll up ${day}; it keeps no finalized row and will be retried. ${describeError(error)}`,
        );
      }
    }

    return { rolled, failed };
  }

  private businessDayAt(epochMs: number): string {
    return businessDayOf(
      new Date(epochMs),
      this.config.get('BUSINESS_TIMEZONE', { infer: true }),
      this.config.get('BUSINESS_DAY_START_HOUR', { infer: true }),
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:e2e -- daily-rollup`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck, lint, format, and commit**

```bash
pnpm typecheck
pnpm lint
npx prettier --write src/reporting test/daily-rollup.e2e-spec.ts
git add src/reporting test/daily-rollup.e2e-spec.ts
git commit -F - <<'EOF'
Roll yesterday up at three in the morning

Same slot and timezone as reconciliation, for the same reason: the
business day starts at 05:00, so at 03:00 the day being rolled has been
closed for 22 hours and the current one has not begun.

Both instances run this and neither coordinates. The day is closed and
3.3 froze its refunds, so they compute identical numbers and the upsert
converges — the expiry sweep's argument, applied again. 11.3 claims a
SET NX lock guards this; that sentence is corrected in a later commit.
EOF
```

---

### Task 4: Recover days the job missed

Without this, an outage leaves permanent holes that only surface when someone pulls an old report.

**Files:**
- Modify: `src/orders/business-day.ts` (add `minusDays`)
- Modify: `src/orders/business-day.spec.ts`
- Modify: `src/reporting/rollup/daily-rollup.service.ts`
- Modify: `test/daily-rollup.e2e-spec.ts`

**Interfaces:**
- Consumes: `RollupSummary` and `rollDays` from Task 3.
- Produces: `minusDays(businessDay: string, days: number): string` exported from `src/orders/business-day`.

- [ ] **Step 1: Write the failing unit test for the date helper**

Add to `src/orders/business-day.spec.ts`:

```ts
describe('minusDays', () => {
  it('steps back within a month', () => {
    expect(minusDays('2026-06-11', 3)).toBe('2026-06-08');
  });

  it('crosses a month boundary', () => {
    expect(minusDays('2026-06-02', 5)).toBe('2026-05-28');
  });

  it('crosses a year boundary', () => {
    expect(minusDays('2026-01-02', 3)).toBe('2025-12-30');
  });

  it('handles a leap day', () => {
    expect(minusDays('2028-03-01', 1)).toBe('2028-02-29');
  });

  it('is calendar arithmetic, so a DST zone cannot shorten a day', () => {
    // 30 days back from the far side of any transition is still 30 calendar
    // days — the value is a date label, not an instant.
    expect(minusDays('2026-11-30', 30)).toBe('2026-10-31');
  });
});
```

Add `minusDays` to the existing import at the top of the file.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- business-day`
Expected: FAIL — `minusDays is not exported` / is not a function.

- [ ] **Step 3: Implement `minusDays`**

In `src/orders/business-day.ts`, add below `businessDayOf`:

```ts
/**
 * A business day label, N calendar days earlier.
 *
 * Calendar arithmetic through `Date.UTC`, for the same reason `businessDayOf`
 * uses it: these are wall-clock date parts, not instants, so treating them as
 * UTC makes the subtraction exact across a daylight-saving change. Month
 * lengths and leap years come from the platform.
 */
export function minusDays(businessDay: string, days: number): string {
  const [year, month, day] = businessDay.split('-').map(Number);
  const shifted = new Date(
    Date.UTC(year, month - 1, day) - days * MILLIS_PER_DAY,
  );
  return formatDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm test -- business-day`
Expected: PASS.

- [ ] **Step 5: Write the failing e2e test for the sweep**

Add inside the `describe('the nightly run', ...)` block in `test/daily-rollup.e2e-spec.ts`:

```ts
    it('rolls up a day the job missed while it was down', async () => {
      pretendItIs('2031-03-02T20:00:00Z'); // 2031-03-03T03:00 Bangkok

      const target = '2031-03-01';
      const missed = '2031-02-27';
      rolledDays.push(target, missed);

      await givenOrder({
        businessDay: target,
        lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
      });
      await givenOrder({
        businessDay: missed,
        lines: [{ itemId: latteId, name: 'Latte', qty: 7, lineMinor: 70_000 }],
      });

      // The outage: `missed` has trade but no rollup row at all.
      expect(await storedRow(missed)).toBeUndefined();

      const summary = await rollup.rollUpYesterday();

      expect(summary.failed).toBe(0);
      expect(summary.rolled).toBeGreaterThanOrEqual(2);
      expect((await storedRow(missed)).revenueMinor).toBe(70_000);
      expect((await storedRow(target)).revenueMinor).toBe(10_000);
    });

    it('leaves days outside the catch-up window alone', async () => {
      pretendItIs('2031-04-02T20:00:00Z'); // 2031-04-03T03:00 Bangkok

      const target = '2031-04-01';
      /**
       * Deliberately in a different year from the `2031-01-XX` days the
       * per-test counter hands out. Picking a January date here would collide
       * with a day an earlier test already finalized, and this assertion would
       * pass or fail for a reason that has nothing to do with the window.
       */
      const ancient = '2030-12-01';
      rolledDays.push(target, ancient);

      await givenOrder({
        businessDay: ancient,
        lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 5_000 }],
      });

      await rollup.rollUpYesterday();

      // Bounded on purpose: the sweep must never become a full table scan.
      expect(await storedRow(ancient)).toBeUndefined();
    });

    /**
     * The mechanism the whole catch-up story rests on: a day that fails must
     * leave no finalized row, because "no finalized row" is exactly what the
     * sweep looks for. If a failure wrote a partial row instead, tomorrow would
     * skip it and the bad numbers would be permanent.
     */
    it('keeps going after a day fails, and leaves that day unfinalized', async () => {
      pretendItIs('2031-05-02T20:00:00Z'); // 2031-05-03T03:00 Bangkok

      const target = '2031-05-01';
      const doomed = '2031-04-20';
      rolledDays.push(target, doomed);

      await givenOrder({
        businessDay: target,
        lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
      });
      await givenOrder({
        businessDay: doomed,
        lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
      });

      // Captured before the spy replaces it, so the good day still really rolls.
      const realRollDay = rollup.rollDay.bind(rollup);
      jest
        .spyOn(rollup, 'rollDay')
        .mockImplementation((day: string) =>
          day === doomed
            ? Promise.reject(new Error('deadlock detected'))
            : realRollDay(day),
        );

      const summary = await rollup.rollUpYesterday();

      expect(summary.failed).toBe(1);
      expect(summary.rolled).toBeGreaterThanOrEqual(1);
      expect((await storedRow(target)).revenueMinor).toBe(10_000);
      expect(await storedRow(doomed)).toBeUndefined();
    });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json daily-rollup -t "missed"`
Expected: FAIL — `expect(received).toBe(70000)` against `undefined`, because nothing sweeps.

- [ ] **Step 7: Implement the sweep**

In `src/reporting/rollup/daily-rollup.service.ts`, extend the drizzle import to
`import { and, asc, eq, exists, gte, isNotNull, lt, notExists, sql, sum } from 'drizzle-orm';`
and add `minusDays` to the `business-day` import.

Add at module scope:

```ts
/**
 * How far back a nightly run will look for days it never finalized.
 *
 * Bounded so the sweep cannot degrade into a full scan of `orders` — the exact
 * failure §11.2 lists first. Thirty days comfortably covers any outage the
 * on-call rota would survive; a longer hole is a manual backfill and a
 * conversation, not a job quietly grinding through a year of history.
 */
const CATCH_UP_DAYS = 30;
```

Replace the body of `rollUpYesterday`:

```ts
  async rollUpYesterday(): Promise<RollupSummary> {
    const target = this.businessDayAt(Date.now() - 24 * 60 * 60 * 1000);
    return this.rollDays([target, ...(await this.missedDays(target))]);
  }
```

and add:

```ts
  /**
   * Business days inside the window that saw trade but carry no finalized
   * rollup — either the job never ran for them, or it ran and failed.
   *
   * Selected from `orders` rather than from a calendar, so the sweep can only
   * ever revisit days that actually happened. A calendar-driven version would
   * manufacture zero rows for every date the cafe was shut.
   */
  private async missedDays(target: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ businessDay: orders.businessDay })
      .from(orders)
      .where(
        and(
          gte(orders.businessDay, minusDays(target, CATCH_UP_DAYS)),
          lt(orders.businessDay, target),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(dailySalesRollups)
              .where(
                and(
                  eq(dailySalesRollups.businessDay, orders.businessDay),
                  isNotNull(dailySalesRollups.finalizedAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(orders.businessDay));

    return rows.map((row) => row.businessDay);
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test:e2e -- daily-rollup`
Expected: PASS, 13 tests.

- [ ] **Step 9: Falsify the sweep test**

This repo has already been bitten by a test that passed without the code it was meant to cover. Prove this one is real:

Temporarily change `rollUpYesterday` back to `return this.rollDays([target]);`, then run:

Run: `npx jest --config ./test/jest-e2e.json daily-rollup -t "missed"`
Expected: **FAIL.** If it still passes, the test is not exercising the sweep — fix the test before restoring the code.

Then restore the `[target, ...(await this.missedDays(target))]` version and re-run to confirm green again.

- [ ] **Step 10: Typecheck, lint, format, and commit**

```bash
pnpm typecheck
pnpm lint
npx prettier --write src/reporting src/orders/business-day.ts src/orders/business-day.spec.ts test/daily-rollup.e2e-spec.ts
git add src/reporting src/orders/business-day.ts src/orders/business-day.spec.ts test/daily-rollup.e2e-spec.ts
git commit -F - <<'EOF'
Let a night's run recover the nights that never happened

A cron that only ever targets one day turns an outage into permanent
holes in history, and quietly retires 11.2's O(days) promise for those
dates — a gap nobody notices until a manager pulls an old report and
gets nothing back.

Each run now also sweeps 30 days back for days that saw trade but carry
no finalized rollup. Bounded, because an unbounded sweep is the growing
scan 11.2 lists as the first thing to break. Selected from orders rather
than from a calendar, so it can only revisit days that happened.

Falsified before trusting: with the sweep removed the catch-up test
fails, so it is testing the sweep and not the target day.
EOF
```

---

### Task 5: Correct §11.3

The spec sentence this slice contradicts. Its own commit because it is judged on prose accuracy, not behaviour.

**Files:**
- Modify: `DESIGN.md:1047`

- [ ] **Step 1: Read the current sentence**

Run: `sed -n '1047p' DESIGN.md`

It currently claims jobs "(expiry, rollups)" are "guarded by Redis locks (`SET NX`) so N instances don't double-run them". Neither job works that way and neither needs to.

- [ ] **Step 2: Amend it**

Replace the clause `jobs (expiry, rollups) guarded by Redis locks (\`SET NX\`) so N instances don't double-run them` with:

```
jobs (expiry, rollups) written to be idempotent rather than locked, so N instances running them concurrently converge instead of colliding — expiry's guarded `WHERE status = 'PENDING_PAYMENT'` matches nothing on the loser, and a rollup recomputes a closed day deterministically and upserts it
```

Leave the rest of the sentence — stateless auth, WS state in Redis, idempotency in Postgres — untouched.

- [ ] **Step 3: Verify no other passage still claims a lock**

Run: `grep -niE "SET NX|distributed lock|redis lock" DESIGN.md`
Expected: no hit that describes rollups or expiry as lock-guarded. If §9.3 or §17 carries the same claim, amend those too and note it in the commit.

- [ ] **Step 4: Commit**

```bash
git add DESIGN.md
git commit -F - <<'EOF'
Describe the jobs as idempotent, because that is what they are

11.3 promised a Redis SET NX lock around expiry and the rollups. No such
helper has ever existed, and neither job wants one: expiry's guarded
transition makes the loser of a race a no-op, and a rollup recomputes a
closed day deterministically, so two instances converge on the same row.

A lock there would buy no correctness and would cost a policy call with
no good answer — fail open and both instances run anyway, fail closed
and a Redis blip silently skips a night's rollup.
EOF
```

---

## Verification before handing over

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` — full unit suite green, count noted (was 378 on `main`)
- [ ] `pnpm test:e2e` — full e2e suite green, count noted (was 698 on `main`)
- [ ] Run the full e2e suite **twice** on a clean rate-limit budget, per the repo's standing practice. A 429 in an unrelated suite is the shared login budget, not a regression.
- [ ] Push the branch and open the PR. **Request Copilot review via the REST endpoint** — `--add-reviewer` does not work for it — and call `gh` by its full path, it is not on `PATH`.
- [ ] Do not merge. Report the PR green and hand the merge command to the user.
