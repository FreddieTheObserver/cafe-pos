import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import type { PaymentMethod } from '../src/database/schema/enums';
import { BusinessDayNotClosedError } from '../src/reporting/errors/reporting.errors';
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
    /**
     * A year safely in the *past*. These tests run against the real clock, and
     * `rollDay` refuses any day that has not finished trading — so a
     * future-dated fixture day would be rejected by the guard rather than
     * rolled. 2020 also predates every real row this database could hold, which
     * is what keeps the totals attributable to the fixture.
     *
     * The clock-mocked blocks below use 2031 dates instead; they move `now`
     * forward to match, and being in a different decade from these days means
     * no catch-up window can ever reach them.
     */
    day = `2020-01-${String(dayCounter).padStart(2, '0')}`;
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
    await givenOrder({
      status: 'COMPLETED',
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
    });
    await givenOrder({
      status: 'REFUNDED',
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
    });
    await givenOrder({
      status: 'CANCELLED',
      paid: false,
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
    });
    await givenOrder({
      status: 'EXPIRED',
      paid: false,
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
    });

    await roll();
    const row = await storedRow();

    expect(row.ordersCompleted).toBe(1);
    expect(row.ordersRefunded).toBe(1);
    expect(row.ordersCancelled).toBe(1);
    expect(row.ordersExpired).toBe(1);
  });

  it('totals revenue by method, with cash included', async () => {
    await givenOrder({
      method: 'CARD',
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 21_000 }],
    });
    await givenOrder({
      method: 'PROMPTPAY',
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 23_000 }],
    });
    await givenOrder({
      method: 'CASH',
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 4_120 }],
    });

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
    await givenOrder({
      method: 'CARD',
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
    });
    await givenOrder({
      method: null,
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 1_500 }],
    });

    await roll();
    const row = await storedRow();

    expect(row.revenueByMethod).toEqual({ CARD: 10_000, UNKNOWN: 1_500 });
    expect(row.revenueMinor).toBe(11_500);
  });

  it('counts only settled refunds', async () => {
    const orderId = await givenOrder({
      lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
    });
    const [payment] = await harness.db
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(eq(schema.payments.orderId, orderId));

    await harness.db.insert(schema.refunds).values([
      {
        paymentId: payment.id,
        amountMinor: 2_150,
        status: 'SUCCEEDED',
        reason: 'Wrong size',
        initiatedByUserId: cashierId,
      },
      {
        paymentId: payment.id,
        amountMinor: 999,
        status: 'FAILED',
        reason: 'Fat finger',
        initiatedByUserId: cashierId,
      },
    ]);

    await roll();
    const row = await storedRow();

    expect(row.refundsMinor).toBe(2_150);
    // Gross revenue: a refund is an offset line, never a subtraction. Without
    // this, a regression that netted refunds off revenue would pass every test
    // in this file.
    expect(row.revenueMinor).toBe(10_000);
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
      lines: [
        { itemId: croissantId, name: 'Croissant', qty: 1, lineMinor: 4_300 },
      ],
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
      {
        menuItemId: latteId,
        name: 'Latte',
        quantity: 11,
        revenueMinor: 110_000,
      },
      {
        menuItemId: croissantId,
        name: 'Croissant',
        quantity: 5,
        revenueMinor: 30_000,
      },
    ]);
  });

  it('ignores orders that were never paid when counting revenue and items', async () => {
    await givenOrder({
      status: 'CANCELLED',
      paid: false,
      vatMinor: 500,
      lines: [{ itemId: latteId, name: 'Latte', qty: 3, lineMinor: 30_000 }],
    });

    await roll();
    const row = await storedRow();

    expect(row.revenueMinor).toBe(0);
    expect(row.vatMinor).toBe(0);
    expect(row.topItems).toEqual([]);
    // The order still counts as cancelled — status counts do not need a payment.
    expect(row.ordersCancelled).toBe(1);
  });

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
       * Deliberately in a different year from the counter-generated days the
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
      // `strictBindCallApply` is off, so `.bind` alone types as `any`; the
      // assertion restores the signature without changing what runs.
      const realRollDay = rollup.rollDay.bind(rollup) as typeof rollup.rollDay;
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
  });

  /**
   * The guard that stops `finalized_at` becoming a seal on a day still taking
   * money.
   *
   * The nightly cron cannot trip this — it only ever names a day that closed 22
   * hours earlier. The guard exists for the read slice: `rollDay` is public and
   * exported, and §5.3's Z-report has to serve *today* flagged `provisional`,
   * so the obvious implementation would finalize a partial day that the
   * catch-up sweep then skips forever.
   */
  describe('the closed-day guard', () => {
    function pretendItIs(iso: string): void {
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse(iso));
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('refuses the business day that is currently open, and writes nothing', async () => {
      // 2031-06-03T03:00 Bangkok. Hour 3 < the 05:00 boundary, so the current
      // business day is still 2031-06-02 — open, and taking money.
      pretendItIs('2031-06-02T20:00:00Z');

      const openDay = '2031-06-02';
      /**
       * Registered for cleanup even though a working guard writes nothing.
       * Deleting the guard to check this test actually fails — which is how it
       * was verified — makes these calls succeed and leave rows behind, and an
       * un-cleaned row then fails the *next* run for a reason that has nothing
       * to do with the guard. Cheap insurance that keeps the check repeatable.
       */
      rolledDays.push(openDay);

      await givenOrder({
        businessDay: openDay,
        lines: [{ itemId: latteId, name: 'Latte', qty: 1, lineMinor: 10_000 }],
      });

      await expect(rollup.rollDay(openDay)).rejects.toThrow(
        BusinessDayNotClosedError,
      );
      expect(await storedRow(openDay)).toBeUndefined();
    });

    it('refuses a business day in the future', async () => {
      pretendItIs('2031-06-02T20:00:00Z');
      rolledDays.push('2031-06-09'); // see the note above

      await expect(rollup.rollDay('2031-06-09')).rejects.toThrow(
        BusinessDayNotClosedError,
      );
      expect(await storedRow('2031-06-09')).toBeUndefined();
    });

    it('still rolls the day that closed most recently', async () => {
      pretendItIs('2031-06-02T20:00:00Z');

      // The business day immediately before the open one — closed at 05:00
      // this morning, so it is fair game.
      const closedDay = '2031-06-01';
      rolledDays.push(closedDay);

      await givenOrder({
        businessDay: closedDay,
        lines: [{ itemId: latteId, name: 'Latte', qty: 2, lineMinor: 20_000 }],
      });

      await expect(rollup.rollDay(closedDay)).resolves.toBeDefined();
      expect((await storedRow(closedDay)).revenueMinor).toBe(20_000);
    });
  });
});
