import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import { IdentityHarness } from './fixtures/identity-fixtures';

interface OrderBody {
  id: string;
  orderNumber: string;
  status: string;
  channel: string;
  businessDay: string;
  customerName: string | null;
  expiresAt: string | null;
  items: {
    nameSnapshot: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    notes: string | null;
    options: { group: string; name: string; priceDeltaMinor: number }[];
  }[];
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  currency: string;
}

/**
 * `POST /orders` (FR-5, FR-6, FR-9, §5.2) against a real database.
 *
 * The unit specs prove the pricing arithmetic; this proves the parts only a
 * migrated Postgres and a booted app can answer for — that the snapshots
 * actually land in their columns, that the queue number is unique per business
 * day, that the aggregate is written in one transaction, and that the §6.4
 * scoping holds for a device token.
 */
describe('Orders endpoint (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;
  let cashierToken: string;
  let kioskToken: string;
  let kioskDeviceId: string;

  let categoryId: string;
  let hiddenCategoryId: string;
  let latteId: string;
  let croissantId: string;
  let soldOutItemId: string;
  let hiddenItemId: string;
  let sizeGroupId: string;
  let extrasGroupId: string;
  let largeId: string;
  let smallId: string;
  let extraShotId: string;
  let soldOutOptionId: string;

  const itemIds: string[] = [];
  const groupIds: string[] = [];
  const categoryIds: string[] = [];

  const auth = (token: string) => `Bearer ${token}`;

  const postOrder = (token: string, body: Record<string, unknown>) =>
    harness
      .http()
      .post('/api/v1/orders')
      .set('Authorization', auth(token))
      .send(body);

  /** A well-formed kiosk basket, so each case varies only what it is about. */
  const kioskBasket = (overrides: Record<string, unknown> = {}) => ({
    channel: 'KIOSK',
    items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
    ...overrides,
  });

  const post = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<string> => {
    const res = await harness
      .http()
      .post(path)
      .set('Authorization', auth(managerToken))
      .send(body);
    if (res.status !== 201) {
      throw new Error(
        `fixture ${path} failed with ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    return (res.body as { id: string }).id;
  };

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    managerToken = await harness.accessTokenFor('MANAGER');
    cashierToken = await harness.accessTokenFor('CASHIER');
    const device = await harness.createDevice('ACTIVE');
    kioskToken = device.token;
    kioskDeviceId = device.id;

    categoryId = await post('/api/v1/categories', {
      name: `Orders drinks ${uuidv7()}`,
      sortOrder: 0,
    });
    hiddenCategoryId = await post('/api/v1/categories', {
      name: `Orders retired ${uuidv7()}`,
      isActive: false,
    });
    categoryIds.push(categoryId, hiddenCategoryId);

    latteId = await post('/api/v1/items', {
      categoryId,
      name: `Orders latte ${uuidv7()}`,
      basePriceMinor: 9500,
    });
    croissantId = await post('/api/v1/items', {
      categoryId,
      name: `Orders croissant ${uuidv7()}`,
      basePriceMinor: 2000,
    });
    soldOutItemId = await post('/api/v1/items', {
      categoryId,
      name: `Orders sold out ${uuidv7()}`,
      basePriceMinor: 4000,
      isAvailable: false,
    });
    // Available in its own right, but its category is unpublished — so it is
    // absent from `GET /menu` and must not be orderable either.
    hiddenItemId = await post('/api/v1/items', {
      categoryId: hiddenCategoryId,
      name: `Orders hidden ${uuidv7()}`,
      basePriceMinor: 100,
    });
    itemIds.push(latteId, croissantId, soldOutItemId, hiddenItemId);

    sizeGroupId = await post('/api/v1/option-groups', {
      name: `Orders size ${uuidv7()}`,
      minSelect: 1,
      maxSelect: 1,
    });
    extrasGroupId = await post('/api/v1/option-groups', {
      name: `Orders extras ${uuidv7()}`,
      minSelect: 0,
      maxSelect: 5,
    });
    groupIds.push(sizeGroupId, extrasGroupId);

    largeId = await post(`/api/v1/option-groups/${sizeGroupId}/options`, {
      name: 'Large',
      priceDeltaMinor: 2000,
    });
    // Negative on purpose: the schema permits it and the floor is pricing's job.
    smallId = await post(`/api/v1/option-groups/${sizeGroupId}/options`, {
      name: 'Small',
      priceDeltaMinor: -1000,
    });
    extraShotId = await post(`/api/v1/option-groups/${extrasGroupId}/options`, {
      name: 'Extra shot',
      priceDeltaMinor: 500,
    });
    soldOutOptionId = await post(
      `/api/v1/option-groups/${extrasGroupId}/options`,
      { name: 'Oat milk', priceDeltaMinor: 1500, isAvailable: false },
    );

    const attach = await harness
      .http()
      .put(`/api/v1/items/${latteId}/option-groups`)
      .set('Authorization', auth(managerToken))
      .send({ optionGroupIds: [sizeGroupId, extrasGroupId] });
    if (attach.status !== 200) {
      throw new Error(`fixture attach failed with ${attach.status}`);
    }
  });

  afterAll(async () => {
    try {
      // Orders first: they hold foreign keys into these items, and unlike the
      // catalog suites this one cannot leave that to `close()` — that shuts the
      // pool down, and the deletes below still need it.
      await harness.purgeOrders();
      if (itemIds.length > 0) {
        await harness.db
          .delete(schema.menuItems)
          .where(inArray(schema.menuItems.id, itemIds));
      }
      if (groupIds.length > 0) {
        await harness.db
          .delete(schema.optionGroups)
          .where(inArray(schema.optionGroups.id, groupIds));
      }
      if (categoryIds.length > 0) {
        await harness.db
          .delete(schema.categories)
          .where(inArray(schema.categories.id, categoryIds));
      }
    } finally {
      await harness.close();
    }
  });

  describe('a kiosk placing an order', () => {
    it('prices it from the catalog and returns the §5.3 shape', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        customerName: 'Mei',
        items: [
          {
            menuItemId: latteId,
            quantity: 1,
            notes: 'less sweet',
            optionIds: [largeId, extraShotId],
          },
          { menuItemId: croissantId, quantity: 2, optionIds: [] },
        ],
      });

      expect(res.status).toBe(201);
      const order = res.body as OrderBody;

      // 9500 + 2000 + 500 = 12000, plus 2 x 2000.
      expect(order.totalMinor).toBe(16000);
      expect(order.subtotalMinor).toBe(16000);
      expect(order.vatMinor).toBe(1047); // round(16000 * 7 / 107)
      expect(order.currency).toBe('THB');
      expect(order.status).toBe('PENDING_PAYMENT');
      expect(order.channel).toBe('KIOSK');
      expect(order.customerName).toBe('Mei');
      expect(order.orderNumber).toMatch(/^A-\d{3,}$/);
      expect(order.businessDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(order.items[0].notes).toBe('less sweet');
      // Snapshotted in the order the customer tapped them, with the group name
      // carried alongside so a receipt reads "Size: Large" without a join.
      const options = order.items[0].options;
      expect(options.map((option) => option.name)).toEqual([
        'Large',
        'Extra shot',
      ]);
      expect(options.map((option) => option.priceDeltaMinor)).toEqual([
        2000, 500,
      ]);
      expect(options[0].group).toContain('Orders size');
      expect(options[1].group).toContain('Orders extras');
    });

    /**
     * FR-6's actual promise. A price edit after the order is placed must not
     * reach into a receipt the customer has already agreed to, which is what
     * the snapshot columns are for — the FK to the live row exists for "top
     * sellers", never for money.
     */
    it('freezes the price against a later menu edit', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
      });
      expect(res.status).toBe(201);

      const repriced = await harness
        .http()
        .patch(`/api/v1/items/${croissantId}`)
        .set('Authorization', auth(managerToken))
        .send({ basePriceMinor: 9900 });
      expect(repriced.status).toBe(200);

      const [line] = await harness.db
        .select()
        .from(schema.orderItems)
        .where(eq(schema.orderItems.orderId, (res.body as OrderBody).id));
      expect(line.unitPriceMinorSnapshot).toBe(2000);
      expect(line.lineTotalMinor).toBe(2000);

      // Put it back, so the cases after this one still price at 2000.
      await harness
        .http()
        .patch(`/api/v1/items/${croissantId}`)
        .set('Authorization', auth(managerToken))
        .send({ basePriceMinor: 2000 });
    });

    it('writes the aggregate and its opening history row (FR-22)', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [
          {
            menuItemId: latteId,
            quantity: 1,
            optionIds: [largeId, extraShotId],
          },
        ],
      });
      const { id } = res.body as OrderBody;

      const [row] = await harness.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, id));
      expect(row.kioskDeviceId).toBe(kioskDeviceId);
      expect(row.createdByUserId).toBeNull();
      expect(row.expiresAt).not.toBeNull();

      const lines = await harness.db
        .select()
        .from(schema.orderItems)
        .where(eq(schema.orderItems.orderId, id));
      expect(lines).toHaveLength(1);

      const options = await harness.db
        .select()
        .from(schema.orderItemOptions)
        .where(eq(schema.orderItemOptions.orderItemId, lines[0].id));
      expect(options).toHaveLength(2);
      expect(options.map((o) => o.optionNameSnapshot).sort()).toEqual([
        'Extra shot',
        'Large',
      ]);

      const history = await harness.db
        .select()
        .from(schema.orderStatusHistory)
        .where(eq(schema.orderStatusHistory.orderId, id));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
        actorType: 'DEVICE',
        actorId: kioskDeviceId,
      });
    });

    /** FR-10: the order holds its queue number for a bounded window. */
    it('stamps an expiry the TTL job can act on', async () => {
      const before = Date.now();
      const res = await postOrder(kioskToken, kioskBasket());
      const { expiresAt } = res.body as OrderBody;

      const expiry = new Date(expiresAt as string).getTime();
      expect(expiry).toBeGreaterThan(before);
      expect(expiry).toBeLessThanOrEqual(before + 10 * 60 * 1000 + 5000);
    });

    /** B3: unique per business day, and the unique index is what enforces it. */
    it('gives concurrent checkouts distinct queue numbers', async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => postOrder(kioskToken, kioskBasket())),
      );

      expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const numbers = responses.map((r) => (r.body as OrderBody).orderNumber);
      expect(new Set(numbers).size).toBe(5);
    });
  });

  describe('a counter order', () => {
    it('records the cashier rather than a device', async () => {
      const res = await postOrder(cashierToken, {
        channel: 'COUNTER',
        items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
      });

      expect(res.status).toBe(201);
      const [row] = await harness.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, (res.body as OrderBody).id));
      expect(row.kioskDeviceId).toBeNull();
      expect(row.createdByUserId).not.toBeNull();
      expect(row.channel).toBe('COUNTER');
    });

    it('refuses a cashier claiming the order came from a kiosk', async () => {
      const res = await postOrder(cashierToken, kioskBasket());

      expect(res.status).toBe(422);
      const problem = res.body as ProblemDetails;
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.[0].field).toBe('channel');
    });

    it('refuses a kiosk claiming to be the counter', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'COUNTER',
        items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
      });

      expect(res.status).toBe(422);
      expect((res.body as ProblemDetails).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('refusing a basket the cafe cannot serve', () => {
    it('rejects an 86ed item and names it (E6)', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: soldOutItemId, quantity: 1, optionIds: [] }],
      });

      expect(res.status).toBe(409);
      const problem = res.body as ProblemDetails;
      expect(problem.code).toBe('ORDER_ITEM_UNAVAILABLE');
      expect(problem.meta).toEqual({
        itemIds: [soldOutItemId],
        optionIds: [],
      });
    });

    /**
     * An unpublished category is absent from `GET /menu` entirely, so a basket
     * naming one of its items is holding a menu from before the change.
     */
    it('rejects an item whose category was unpublished', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: hiddenItemId, quantity: 1, optionIds: [] }],
      });

      expect(res.status).toBe(409);
      expect((res.body as ProblemDetails).meta).toEqual({
        itemIds: [hiddenItemId],
        optionIds: [],
      });
    });

    it('rejects an 86ed option', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [
          {
            menuItemId: latteId,
            quantity: 1,
            optionIds: [largeId, soldOutOptionId],
          },
        ],
      });

      expect(res.status).toBe(409);
      expect((res.body as ProblemDetails).meta).toEqual({
        itemIds: [],
        optionIds: [soldOutOptionId],
      });
    });

    it('rejects an id the catalog does not have', async () => {
      const ghost = uuidv7();
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: ghost, quantity: 1, optionIds: [] }],
      });

      expect(res.status).toBe(409);
      expect((res.body as ProblemDetails).meta).toEqual({
        itemIds: [ghost],
        optionIds: [],
      });
    });

    it('rejects a required group left unselected (B2)', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: latteId, quantity: 1, optionIds: [] }],
      });

      expect(res.status).toBe(422);
      const problem = res.body as ProblemDetails;
      expect(problem.code).toBe('OPTION_SELECTION_INVALID');
      expect(problem.meta?.violations).toEqual([
        expect.objectContaining({
          itemIndex: 0,
          rule: 'MIN_SELECT',
          optionGroupId: sizeGroupId,
        }),
      ]);
    });

    it('rejects an option that belongs to no group on that item', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: croissantId, quantity: 1, optionIds: [largeId] }],
      });

      expect(res.status).toBe(422);
      expect((res.body as ProblemDetails).meta?.violations).toEqual([
        { itemIndex: 0, rule: 'UNKNOWN_OPTION', optionIds: [largeId] },
      ]);
    });

    /** E7: never charge a number the customer was not shown. */
    it('rejects a total the kiosk did not display', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
        expectedTotalMinor: 1,
      });

      expect(res.status).toBe(409);
      const problem = res.body as ProblemDetails;
      expect(problem.code).toBe('PRICE_MISMATCH');
      expect(problem.meta).toEqual({
        expectedTotalMinor: 1,
        actualTotalMinor: 2000,
      });
    });

    it('accepts a total that matches', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
        expectedTotalMinor: 2000,
      });

      expect(res.status).toBe(201);
    });

    /**
     * The E6 answer comes before the E7 one deliberately: the sold-out item is
     * the thing the customer has to act on, and re-pricing a basket they cannot
     * buy is wasted taps.
     */
    it('answers sold-out before price-mismatch', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: soldOutItemId, quantity: 1, optionIds: [] }],
        expectedTotalMinor: 999999,
      });

      expect((res.body as ProblemDetails).code).toBe('ORDER_ITEM_UNAVAILABLE');
    });

    /**
     * A basket that fails must leave nothing behind — not a queue number, not a
     * half-written aggregate. Counted rather than listed, because other suites
     * share the database.
     */
    it('writes no rows at all when it refuses', async () => {
      const before = await harness.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.kioskDeviceId, kioskDeviceId));

      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: soldOutItemId, quantity: 1, optionIds: [] }],
      });
      expect(res.status).toBe(409);

      const after = await harness.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.kioskDeviceId, kioskDeviceId));
      expect(after).toHaveLength(before.length);
    });
  });

  describe('the negative-delta floor', () => {
    /**
     * The obligation Phase 2 handed over, end to end: `price_delta_minor` has
     * no CHECK, so a menu can be configured into a negative line, and only the
     * server sees the whole basket.
     */
    it('never stores a line total below zero', async () => {
      const cheap = await post('/api/v1/items', {
        categoryId,
        name: `Orders cheap ${uuidv7()}`,
        basePriceMinor: 500,
      });
      itemIds.push(cheap);

      const attach = await harness
        .http()
        .put(`/api/v1/items/${cheap}/option-groups`)
        .set('Authorization', auth(managerToken))
        .send({ optionGroupIds: [sizeGroupId] });
      expect(attach.status).toBe(200);

      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: cheap, quantity: 3, optionIds: [smallId] }],
      });

      expect(res.status).toBe(201);
      const order = res.body as OrderBody;
      expect(order.items[0].unitPriceMinor).toBe(0);
      expect(order.items[0].lineTotalMinor).toBe(0);
      expect(order.totalMinor).toBe(0);
      expect(order.vatMinor).toBe(0);
    });
  });

  describe('device state', () => {
    it('refuses ordering from a paused tablet but leaves the menu readable', async () => {
      const paused = await harness.createDevice('PAUSED');

      const order = await postOrder(paused.token, kioskBasket());
      expect(order.status).toBe(409);
      expect((order.body as ProblemDetails).code).toBe('DEVICE_PAUSED');

      // §5.2 pauses ordering, not the device: it still needs the menu to
      // render its "ordering paused" screen.
      const menu = await harness
        .http()
        .get('/api/v1/menu')
        .set('Authorization', auth(paused.token));
      expect(menu.status).toBe(200);
    });

    it('refuses a revoked tablet at the guard', async () => {
      const revoked = await harness.createDevice('REVOKED');

      const res = await postOrder(revoked.token, kioskBasket());
      expect(res.status).toBe(401);
      expect((res.body as ProblemDetails).code).toBe('DEVICE_REVOKED');
    });
  });

  describe('request validation (§8)', () => {
    it('refuses an empty basket', async () => {
      const res = await postOrder(kioskToken, { channel: 'KIOSK', items: [] });

      expect(res.status).toBe(422);
      expect((res.body as ProblemDetails).code).toBe('VALIDATION_FAILED');
    });

    it('refuses more than thirty lines', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: Array.from({ length: 31 }, () => ({
          menuItemId: croissantId,
          quantity: 1,
          optionIds: [],
        })),
      });

      expect(res.status).toBe(422);
    });

    it('refuses a quantity above fifty', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: croissantId, quantity: 51, optionIds: [] }],
      });

      expect(res.status).toBe(422);
    });

    // `strictObject` everywhere: an unknown field is a client bug worth
    // hearing about now rather than a silently ignored one (§8).
    it('refuses an unknown field', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
        totalMinor: 0,
      });

      expect(res.status).toBe(422);
    });

    it('refuses a client-supplied price on a line', async () => {
      const res = await postOrder(kioskToken, {
        channel: 'KIOSK',
        items: [
          {
            menuItemId: croissantId,
            quantity: 1,
            optionIds: [],
            unitPriceMinor: 1,
          },
        ],
      });

      expect(res.status).toBe(422);
    });
  });
});
