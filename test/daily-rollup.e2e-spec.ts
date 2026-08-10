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
