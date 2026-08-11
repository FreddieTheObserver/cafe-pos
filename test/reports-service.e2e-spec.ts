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
