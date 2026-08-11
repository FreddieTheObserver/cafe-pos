import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { businessDayOf } from '../src/orders/business-day';
import type {
  SalesReport,
  TopItemsReport,
  ZReport,
} from '../src/reporting/reports/reports.service';
import { IdentityHarness } from './fixtures/identity-fixtures';

describe('Reports HTTP (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;
  let cashierToken: string;
  let baristaToken: string;
  let cashierId: string;
  let categoryId: string;
  let latteId: string;
  let croissantId: string;
  let currentDay: string;

  const touchedDays: string[] = [];
  const DAY = '2021-09-01';

  // Consulted by the stubbed provider below; only the z-report describe
  // block below flips it, and it is reset to true before each of its tests.
  let gatewayReachable = true;

  const salesOf = (res: { body: unknown }): SalesReport =>
    res.body as SalesReport;
  const topItemsOf = (res: { body: unknown }): TopItemsReport =>
    res.body as TopItemsReport;
  const zReportOf = (res: { body: unknown }): ZReport => res.body as ZReport;

  async function givenPaidOrder(
    businessDay: string,
    lineMinor: number,
    qty = 1,
    itemId: string = latteId,
    nameSnapshot = 'Latte',
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
      menuItemId: itemId,
      nameSnapshot,
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
    /**
     * Stubbed rather than left to the real Stripe adapter: `stripe-mock` runs
     * locally in this environment, so an unstubbed gateway call could well
     * succeed or fail depending on what is running, rather than on what the
     * test means to exercise. This only affects reconciliation — sales and
     * top-items never call the provider. `gatewayReachable` makes it
     * switchable, the way `test/reconciliation.e2e-spec.ts` does it, so both
     * the reachable and unreachable cases are test-controlled rather than one
     * of them being permanently unreachable and untestable.
     */
    harness = await IdentityHarness.boot({
      paymentProvider: {
        capturedTotalFor: (intentIds) =>
          gatewayReachable
            ? Promise.resolve({ totalMinor: 0, notCaptured: [...intentIds] })
            : Promise.reject(new Error('Stripe is unreachable')),
      },
    });
    cashierId = (await harness.createStaff('CASHIER')).id;
    // Same pattern `refunds.e2e-spec.ts` uses: read the real config rather
    // than hardcoding a zone/hour that would drift from what the service uses.
    currentDay = businessDayOf(
      new Date(),
      process.env.BUSINESS_TIMEZONE ?? 'Asia/Bangkok',
      Number(process.env.BUSINESS_DAY_START_HOUR ?? 5),
    );
    // tokenFor mints through AccessTokenService rather than POST /auth/login,
    // so these do not spend the shared per-IP login budget.
    managerToken = await harness.tokenFor('MANAGER');
    cashierToken = await harness.tokenFor('CASHIER');
    baristaToken = await harness.tokenFor('BARISTA');

    categoryId = uuidv7();
    latteId = uuidv7();
    croissantId = uuidv7();
    await harness.db
      .insert(schema.categories)
      .values({ id: categoryId, name: `Reports HTTP ${categoryId}` });
    await harness.db.insert(schema.menuItems).values({
      id: latteId,
      categoryId,
      name: 'Latte',
      basePriceMinor: 10_000,
    });
    await harness.db.insert(schema.menuItems).values({
      id: croissantId,
      categoryId,
      name: 'Croissant',
      basePriceMinor: 5_000,
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
      .delete(schema.menuItems)
      .where(eq(schema.menuItems.id, croissantId));
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
      expect(salesOf(res).buckets).toEqual([
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
      expect(salesOf(res).buckets).toHaveLength(12);
    });

    it('returns hourly buckets from the live tables', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/sales?from=${DAY}&to=${DAY}&groupBy=hour`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(salesOf(res).groupBy).toBe('hour');
      expect(salesOf(res).buckets).toHaveLength(1);
      expect(salesOf(res).buckets[0]).toMatchObject({
        revenueMinor: 20_000,
        ordersSettled: 2,
        avgTicketMinor: 10_000,
      });
      // Business-day-keyed, per finding 1 — not the wall-clock calendar date.
      expect(salesOf(res).buckets[0].bucket).toMatch(/^2021-09-01T\d{2}$/);
    });

    it('flags a range that includes the day still taking money', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/sales?from=${currentDay}&to=${currentDay}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(salesOf(res).provisional).toBe(true);
    });
  });

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
      expect(topItemsOf(res).items).toEqual([
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
      expect(topItemsOf(res).items).toHaveLength(1);
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

    it('drops lower-ranked items when the limit bites', async () => {
      const day = '2021-09-20';

      // Croissant outsells Latte on this day, so a working limit keeps the
      // Croissant and drops the Latte. With one item seeded, as the sibling
      // test has, any limit >= 1 would look correct.
      await givenPaidOrder(day, 3_000, 3, croissantId, 'Croissant');
      await givenPaidOrder(day, 1_000, 1);

      touchedDays.push(day);

      const res = await harness
        .http()
        .get(`/api/v1/reports/top-items?from=${day}&to=${day}&limit=1`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(topItemsOf(res).items).toEqual([
        {
          menuItemId: croissantId,
          name: 'Croissant',
          quantity: 3,
          revenueMinor: 3_000,
        },
      ]);
    });

    it('flags a range that includes the day still taking money', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/top-items?from=${currentDay}&to=${currentDay}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(topItemsOf(res).provisional).toBe(true);
    });
  });

  describe('GET /reports/z-report', () => {
    // Only 'serves the report ... gateway is down' turns this off; every
    // other test in this block sees a reachable gateway.
    beforeEach(() => {
      gatewayReachable = true;
    });

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
      expect(zReportOf(res)).toMatchObject({
        businessDay: DAY,
        provisional: false,
        revenueMinor: { total: 20_000, byMethod: { CASH: 20_000 } },
        refundsMinor: 0,
        vatMinor: 0,
      });
      expect(zReportOf(res).orders).toMatchObject({ completed: 2 });
    });

    it('embeds a computed reconciliation for a closed day', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/z-report?businessDay=${DAY}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      const body = zReportOf(res);
      expect(body.reconciliationUnavailable).toBeNull();
      expect(body.reconciliation).not.toBeNull();
      // Cash-only day: nothing went through the gateway, so both sides are 0.
      expect(body.reconciliation!.deltaMinor).toBe(0);
      expect(body.reconciliation!.gatewayCapturedMinor).toBe(0);
      expect(body.reconciliation!.dbRecordedMinor).toBe(0);
    });

    /**
     * The figures a manager cashes up against never depended on the gateway,
     * so a Stripe outage must not withhold them — but the delta must never be
     * fabricated as zero either.
     */
    it('serves the report with reconciliation explicitly unavailable when the gateway is down', async () => {
      gatewayReachable = false;

      const res = await harness
        .http()
        .get(`/api/v1/reports/z-report?businessDay=${DAY}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(zReportOf(res).reconciliation).toBeNull();
      expect(zReportOf(res).reconciliationUnavailable).toBe(
        'GATEWAY_UNREACHABLE',
      );
    });

    it('flags the open business day and skips reconciliation as meaningless', async () => {
      const res = await harness
        .http()
        .get(`/api/v1/reports/z-report?businessDay=${currentDay}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      const body = zReportOf(res);
      expect(body.provisional).toBe(true);
      expect(body.reconciliation).toBeNull();
      expect(body.reconciliationUnavailable).toBe('DAY_STILL_TRADING');
    });
  });
});
