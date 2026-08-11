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
