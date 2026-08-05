import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import { OrderExpiryService } from '../src/orders/expiry/order-expiry.service';
import { IdentityHarness } from './fixtures/identity-fixtures';

interface OrderBody {
  id: string;
  orderNumber: string | null;
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

/** A row of `GET /orders` — the summary shape, without line items. */
interface OrderSummaryBody {
  id: string;
  orderNumber: string | null;
  status: string;
  channel: string;
  businessDay: string;
  customerName: string | null;
  totalMinor: number;
  currency: string;
  createdAt: string;
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
  let baristaToken: string;
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
  const usedKeys: string[] = [];

  const auth = (token: string) => `Bearer ${token}`;

  const postOrder = (
    token: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ) => {
    const call = harness
      .http()
      .post('/api/v1/orders')
      .set('Authorization', auth(token));
    if (idempotencyKey !== undefined) {
      call.set('Idempotency-Key', idempotencyKey);
      usedKeys.push(idempotencyKey);
    }
    return call.send(body);
  };

  /** A fresh key, tracked so the suite can delete its rows afterwards. */
  const newKey = () => `k-${uuidv7()}`;

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
    baristaToken = await harness.accessTokenFor('BARISTA');
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
      if (usedKeys.length > 0) {
        await harness.db
          .delete(schema.idempotencyKeys)
          .where(inArray(schema.idempotencyKeys.key, usedKeys));
      }
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

  /**
   * §5.7 and E5. The case this exists for is a kiosk on flaky wifi that timed
   * out and retried — so the retry frequently arrives while the original is
   * still running, and "check then insert" would let both through.
   */
  describe('idempotency keys', () => {
    const countOrders = async () =>
      (
        await harness.db
          .select()
          .from(schema.orders)
          .where(eq(schema.orders.kioskDeviceId, kioskDeviceId))
      ).length;

    it('replays the original order instead of placing a second', async () => {
      const key = newKey();
      const before = await countOrders();

      const first = await postOrder(kioskToken, kioskBasket(), key);
      const second = await postOrder(kioskToken, kioskBasket(), key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((second.body as OrderBody).id).toBe((first.body as OrderBody).id);
      expect((second.body as OrderBody).orderNumber).toBe(
        (first.body as OrderBody).orderNumber,
      );
      expect(await countOrders()).toBe(before + 1);
    });

    it('marks the replay so a client can tell it from a new order', async () => {
      const key = newKey();

      const first = await postOrder(kioskToken, kioskBasket(), key);
      const second = await postOrder(kioskToken, kioskBasket(), key);

      expect(first.headers['idempotency-replayed']).toBeUndefined();
      expect(second.headers['idempotency-replayed']).toBe('true');
    });

    /**
     * The concurrent case, which is the one the reserve-then-work design is
     * for: the second request blocks on the reserved primary key rather than
     * racing past it, and replays once the first commits.
     */
    it('survives two identical requests in flight at once', async () => {
      const key = newKey();
      const before = await countOrders();

      const [a, b] = await Promise.all([
        postOrder(kioskToken, kioskBasket(), key),
        postOrder(kioskToken, kioskBasket(), key),
      ]);

      expect([a.status, b.status]).toEqual([201, 201]);
      expect((a.body as OrderBody).id).toBe((b.body as OrderBody).id);
      expect(await countOrders()).toBe(before + 1);

      // Exactly one of the two did the work; the other replayed it.
      const replayed = [a, b].filter(
        (res) => res.headers['idempotency-replayed'] === 'true',
      );
      expect(replayed).toHaveLength(1);
    });

    it('refuses the same key carrying a different basket', async () => {
      const key = newKey();

      await postOrder(kioskToken, kioskBasket(), key);
      const second = await postOrder(
        kioskToken,
        kioskBasket({
          items: [{ menuItemId: croissantId, quantity: 2, optionIds: [] }],
        }),
        key,
      );

      expect(second.status).toBe(409);
      expect((second.body as ProblemDetails).code).toBe('IDEMPOTENCY_CONFLICT');
    });

    // Canonicalisation, end to end: the same basket serialised with its keys in
    // a different order is the same request, not a conflict.
    it('ignores the order the client serialised its JSON in', async () => {
      const key = newKey();

      const first = await postOrder(
        kioskToken,
        {
          channel: 'KIOSK',
          customerName: 'Mei',
          items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
        },
        key,
      );
      const second = await postOrder(
        kioskToken,
        {
          items: [{ quantity: 1, optionIds: [], menuItemId: croissantId }],
          customerName: 'Mei',
          channel: 'KIOSK',
        },
        key,
      );

      expect(second.status).toBe(201);
      expect((second.body as OrderBody).id).toBe((first.body as OrderBody).id);
    });

    it('treats two different keys as two orders', async () => {
      const first = await postOrder(kioskToken, kioskBasket(), newKey());
      const second = await postOrder(kioskToken, kioskBasket(), newKey());

      expect((second.body as OrderBody).id).not.toBe(
        (first.body as OrderBody).id,
      );
    });

    it('leaves an order with no key entirely alone', async () => {
      const first = await postOrder(kioskToken, kioskBasket());
      const second = await postOrder(kioskToken, kioskBasket());

      expect((second.body as OrderBody).id).not.toBe(
        (first.body as OrderBody).id,
      );
    });

    /**
     * A refused order stores nothing, because the reservation dies with the
     * rolled-back transaction. Without that, one 86'd item would poison the
     * customer's key and they could never place that order at all.
     */
    it('does not burn a key on an order it refused', async () => {
      const key = newKey();

      const eightySix = await harness
        .http()
        .patch(`/api/v1/items/${croissantId}/availability`)
        .set('Authorization', auth(managerToken))
        .send({ isAvailable: false });
      expect(eightySix.status).toBe(200);

      const refused = await postOrder(kioskToken, kioskBasket(), key);
      expect(refused.status).toBe(409);
      expect((refused.body as ProblemDetails).code).toBe(
        'ORDER_ITEM_UNAVAILABLE',
      );

      const restored = await harness
        .http()
        .patch(`/api/v1/items/${croissantId}/availability`)
        .set('Authorization', auth(managerToken))
        .send({ isAvailable: true });
      expect(restored.status).toBe(200);

      // Same key, now that the pastry is back.
      const retried = await postOrder(kioskToken, kioskBasket(), key);
      expect(retried.status).toBe(201);
    });

    /**
     * Keys are scoped to the principal that presented them, so a guessed key
     * cannot be used to pull back another tablet's order — the hash disagrees
     * and the second device is refused rather than handed a receipt.
     */
    it('will not let one device replay another device"s key', async () => {
      const key = newKey();
      const other = await harness.createDevice('ACTIVE');

      const mine = await postOrder(kioskToken, kioskBasket(), key);
      expect(mine.status).toBe(201);

      const theirs = await postOrder(other.token, kioskBasket(), key);
      expect(theirs.status).toBe(409);
      expect((theirs.body as ProblemDetails).code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('refuses a malformed key rather than silently ignoring it', async () => {
      const res = await harness
        .http()
        .post('/api/v1/orders')
        .set('Authorization', auth(kioskToken))
        .set('Idempotency-Key', 'no')
        .send(kioskBasket());

      expect(res.status).toBe(422);
      const problem = res.body as ProblemDetails;
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.[0].field).toBe('Idempotency-Key');
    });
  });

  /**
   * `GET /orders` and `GET /orders/:id` (§5.1, §5.2, §5.6).
   *
   * The list is filtered to this suite's own device wherever it can be, because
   * other suites share the database and an assertion about "the first page"
   * would otherwise depend on what else ran today.
   */
  describe('reading orders back', () => {
    let mine: OrderBody[];

    const listAs = (token: string, query = '') =>
      harness
        .http()
        .get(`/api/v1/orders${query}`)
        .set('Authorization', auth(token));

    const pageOf = (res: { body: unknown }) =>
      res.body as { orders: OrderSummaryBody[]; nextCursor: string | null };

    beforeAll(async () => {
      // Three orders, distinct totals, placed in a known sequence.
      const responses: OrderBody[] = [];
      for (const quantity of [1, 2, 3]) {
        const res = await postOrder(kioskToken, {
          channel: 'KIOSK',
          customerName: quantity === 2 ? 'Priya' : null,
          items: [{ menuItemId: croissantId, quantity, optionIds: [] }],
        });
        expect(res.status).toBe(201);
        responses.push(res.body as OrderBody);
      }
      mine = responses;
    });

    it('lists orders newest first by default', async () => {
      const res = await listAs(cashierToken, '?channel=KIOSK&limit=100');

      expect(res.status).toBe(200);
      const ids = pageOf(res).orders.map((order) => order.id);
      const positions = mine.map((order) => ids.indexOf(order.id));
      expect(positions.every((index) => index >= 0)).toBe(true);
      // Placed 1, 2, 3 — so they come back 3, 2, 1.
      expect(positions[0]).toBeGreaterThan(positions[1]);
      expect(positions[1]).toBeGreaterThan(positions[2]);
    });

    it('carries the summary a lookup screen needs, and no line items', async () => {
      const res = await listAs(cashierToken, '?channel=KIOSK&limit=100');
      const found = pageOf(res).orders.find((o) => o.id === mine[0].id);

      expect(found).toMatchObject({
        orderNumber: mine[0].orderNumber,
        status: 'PENDING_PAYMENT',
        channel: 'KIOSK',
        totalMinor: 2000,
        currency: 'THB',
      });
      expect(found?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(found).not.toHaveProperty('items');
    });

    /**
     * The property that makes cursor pagination worth the trouble: walking the
     * pages visits every row exactly once, even though rows are being inserted
     * by other cases while the walk happens.
     */
    it('walks every row exactly once across pages', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 20; page++) {
        const query: string =
          `?channel=KIOSK&limit=2` +
          (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
        const res = await listAs(cashierToken, query);
        expect(res.status).toBe(200);

        const body = pageOf(res);
        seen.push(...body.orders.map((order) => order.id));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      expect(new Set(seen).size).toBe(seen.length);
      for (const order of mine) expect(seen).toContain(order.id);
    });

    it('stops handing out a cursor on the last page', async () => {
      const res = await listAs(cashierToken, '?channel=KIOSK&limit=100');

      expect(pageOf(res).nextCursor).toBeNull();
    });

    it('sorts by total when asked, and pages that way too', async () => {
      const res = await listAs(
        cashierToken,
        '?channel=KIOSK&sort=totalMinor&limit=100',
      );

      const totals = pageOf(res).orders.map((order) => order.totalMinor);
      expect(totals).toEqual([...totals].sort((a, b) => a - b));
    });

    /** A cursor cut for one sort is meaningless against another column. */
    it('refuses a cursor carried across a change of sort', async () => {
      const first = await listAs(cashierToken, '?channel=KIOSK&limit=1');
      const cursor = pageOf(first).nextCursor;
      expect(cursor).not.toBeNull();

      const res = await listAs(
        cashierToken,
        `?channel=KIOSK&sort=totalMinor&limit=1&cursor=${encodeURIComponent(cursor as string)}`,
      );

      expect(res.status).toBe(422);
      expect((res.body as ProblemDetails).errors?.[0].field).toBe('cursor');
    });

    /**
     * A cursor is opaque, not trusted. It carries a value that reaches a cast
     * in the WHERE clause, so a well-shaped cursor with a nonsense value must
     * still be refused at the edge — otherwise the driver raises on
     * `'nope'::timestamptz` and a client input problem surfaces as a 500.
     */
    it.each([
      ['-createdAt', 'not-a-timestamp'],
      ['totalMinor', 'not-a-number'],
    ])('refuses a %s cursor carrying a nonsense value', async (sort, value) => {
      const forged = Buffer.from(
        JSON.stringify({ s: sort, v: value, i: uuidv7() }),
      ).toString('base64url');

      const res = await listAs(
        cashierToken,
        `?sort=${sort}&limit=5&cursor=${encodeURIComponent(forged)}`,
      );

      expect(res.status).toBe(422);
      expect((res.body as ProblemDetails).errors?.[0].field).toBe('cursor');
    });

    it('filters by status', async () => {
      const res = await listAs(cashierToken, '?status=PAID&limit=100');

      expect(res.status).toBe(200);
      expect(pageOf(res).orders.every((order) => order.status === 'PAID')).toBe(
        true,
      );
      expect(pageOf(res).orders.map((o) => o.id)).not.toContain(mine[0].id);
    });

    it('accepts a comma-separated list of statuses', async () => {
      const res = await listAs(
        cashierToken,
        '?status=PENDING_PAYMENT,PAID&channel=KIOSK&limit=100',
      );

      expect(res.status).toBe(200);
      expect(pageOf(res).orders.map((o) => o.id)).toContain(mine[0].id);
    });

    it('refuses a status the enum does not have', async () => {
      const res = await listAs(cashierToken, '?status=DELICIOUS');

      expect(res.status).toBe(422);
    });

    it('finds an order by its queue number', async () => {
      // Non-null because these were checked out, not parked — a DRAFT has no
      // number to search for, which is B3's whole point.
      const queueNumber = mine[0].orderNumber as string;
      const res = await listAs(
        cashierToken,
        `?q=${encodeURIComponent(queueNumber)}&businessDay=${mine[0].businessDay}`,
      );

      expect(res.status).toBe(200);
      expect(pageOf(res).orders.map((o) => o.id)).toContain(mine[0].id);
    });

    it('finds an order by a customer-name prefix', async () => {
      const res = await listAs(cashierToken, '?q=Pri&channel=KIOSK&limit=100');

      expect(res.status).toBe(200);
      expect(pageOf(res).orders.map((o) => o.id)).toContain(mine[1].id);
    });

    /**
     * A `q` of `%` would otherwise match every named order in the cafe. Not a
     * disclosure a staff-only route frets about, but it is a needless full
     * scan, and the same habit on a public route is how these become real.
     */
    it('treats a LIKE wildcard as a literal', async () => {
      const res = await listAs(cashierToken, '?q=%25&channel=KIOSK&limit=100');

      expect(res.status).toBe(200);
      expect(pageOf(res).orders.map((o) => o.id)).not.toContain(mine[1].id);
    });

    it('filters by business day', async () => {
      const res = await listAs(
        cashierToken,
        `?businessDay=${mine[0].businessDay}&channel=KIOSK&limit=100`,
      );

      expect(res.status).toBe(200);
      expect(pageOf(res).orders.map((o) => o.id)).toContain(mine[0].id);

      const empty = await listAs(cashierToken, '?businessDay=1999-01-01');
      expect(pageOf(empty).orders).toHaveLength(0);
    });

    it('refuses a half-open date range', async () => {
      const res = await listAs(cashierToken, '?from=2026-06-01T00:00:00Z');

      expect(res.status).toBe(422);
    });

    it('refuses a range wider than 92 days', async () => {
      const res = await listAs(
        cashierToken,
        '?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z',
      );

      expect(res.status).toBe(422);
    });

    it('refuses a from after its to', async () => {
      const res = await listAs(
        cashierToken,
        '?from=2026-06-10T00:00:00Z&to=2026-06-01T00:00:00Z',
      );

      expect(res.status).toBe(422);
    });

    it('refuses a limit above the ceiling', async () => {
      expect((await listAs(cashierToken, '?limit=101')).status).toBe(422);
      expect((await listAs(cashierToken, '?limit=0')).status).toBe(422);
    });

    it('refuses a sort outside the whitelist', async () => {
      const res = await listAs(cashierToken, '?sort=passwordHash');

      expect(res.status).toBe(422);
    });

    it('refuses an unknown filter rather than ignoring it', async () => {
      const res = await listAs(cashierToken, '?statuss=PAID');

      expect(res.status).toBe(422);
    });

    describe('one order in full', () => {
      const detailAs = (token: string, id: string) =>
        harness
          .http()
          .get(`/api/v1/orders/${id}`)
          .set('Authorization', auth(token));

      it('returns the lines, their options and the audit trail', async () => {
        const created = await postOrder(kioskToken, {
          channel: 'KIOSK',
          items: [
            {
              menuItemId: latteId,
              quantity: 1,
              notes: 'extra hot',
              optionIds: [largeId, extraShotId],
            },
          ],
        });
        const { id } = created.body as OrderBody;

        const res = await detailAs(cashierToken, id);
        expect(res.status).toBe(200);

        const detail = res.body as OrderBody & {
          statusHistory: { fromStatus: string | null; toStatus: string }[];
        };
        expect(detail.items).toHaveLength(1);
        expect(detail.items[0].notes).toBe('extra hot');
        expect(detail.items[0].options).toHaveLength(2);
        expect(detail.statusHistory).toEqual([
          expect.objectContaining({
            fromStatus: null,
            toStatus: 'PENDING_PAYMENT',
            actorType: 'DEVICE',
          }),
        ]);
      });

      it('lets the kiosk that placed it read it back', async () => {
        const res = await detailAs(kioskToken, mine[0].id);

        expect(res.status).toBe(200);
        expect((res.body as OrderBody).id).toBe(mine[0].id);
      });

      /**
       * §5.4 is explicit: an out-of-scope resource must not be distinguishable
       * from a missing one. A 403 here would let one tablet in a public space
       * enumerate what the cafe sold today, one id at a time.
       */
      it('answers 404, not 403, for another device"s order', async () => {
        const other = await harness.createDevice('ACTIVE');

        const res = await detailAs(other.token, mine[0].id);

        expect(res.status).toBe(404);
        expect((res.body as ProblemDetails).code).toBe('RESOURCE_NOT_FOUND');
      });

      it('answers 404 identically for an order that never existed', async () => {
        const other = await harness.createDevice('ACTIVE');

        const missing = await detailAs(other.token, uuidv7());
        const foreign = await detailAs(other.token, mine[0].id);

        expect(missing.status).toBe(foreign.status);
        expect((missing.body as ProblemDetails).code).toBe(
          (foreign.body as ProblemDetails).code,
        );
      });

      it('refuses an id that is not a uuid', async () => {
        const res = await detailAs(cashierToken, 'not-a-uuid');

        expect(res.status).toBe(422);
      });
    });
  });

  /**
   * `POST /orders/:id/status` (§4.4, §5.2, FR-16, E8).
   *
   * Every case starts from a `PAID` order written straight to the database.
   * That is a fixture, not a shortcut: §4.4 is explicit that `PAID` is reached
   * only from a payment-side fact, and there is no payment door until Phase 4.
   * Writing the status directly sets up the state without pretending an
   * endpoint exists that could.
   */
  describe('moving an order through the kitchen', () => {
    const transition = (token: string, id: string, to: string) =>
      harness
        .http()
        .post(`/api/v1/orders/${id}/status`)
        .set('Authorization', auth(token))
        .send({ to });

    /** An order parked in `PAID`, ready for the KDS to pick up. */
    const paidOrder = async (): Promise<string> => {
      const res = await postOrder(kioskToken, kioskBasket());
      expect(res.status).toBe(201);
      const { id } = res.body as OrderBody;

      await harness.db
        .update(schema.orders)
        .set({ status: 'PAID', expiresAt: null })
        .where(eq(schema.orders.id, id));

      return id;
    };

    it('walks the KDS path and returns the order at each step', async () => {
      const id = await paidOrder();

      const started = await transition(baristaToken, id, 'IN_PREPARATION');
      expect(started.status).toBe(200);
      expect((started.body as OrderSummaryBody).status).toBe('IN_PREPARATION');

      const ready = await transition(baristaToken, id, 'READY');
      expect(ready.status).toBe(200);
      expect((ready.body as OrderSummaryBody).status).toBe('READY');

      const done = await transition(baristaToken, id, 'COMPLETED');
      expect(done.status).toBe(200);
      expect((done.body as OrderSummaryBody).status).toBe('COMPLETED');
    });

    it('records every move with the staff member who made it (FR-22)', async () => {
      const id = await paidOrder();
      await transition(baristaToken, id, 'IN_PREPARATION');
      await transition(baristaToken, id, 'READY');

      const history = await harness.db
        .select()
        .from(schema.orderStatusHistory)
        .where(eq(schema.orderStatusHistory.orderId, id));

      const moves = history
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((row) => [row.fromStatus, row.toStatus]);

      // The creation row, then the two moves. The PAID fixture is a direct
      // write and deliberately leaves no history behind.
      expect(moves).toEqual([
        [null, 'PENDING_PAYMENT'],
        ['PAID', 'IN_PREPARATION'],
        ['IN_PREPARATION', 'READY'],
      ]);
      expect(
        history.filter((row) => row.toStatus === 'IN_PREPARATION')[0],
      ).toMatchObject({ actorType: 'USER' });
    });

    /**
     * E8, the reason the update is guarded. Two baristas tap "start" on the
     * same ticket; both read PAID and both send the same request. Without
     * `WHERE status = :from` the second silently overwrites the first and the
     * history claims the order started twice.
     */
    it('lets exactly one of two baristas win the same ticket', async () => {
      const id = await paidOrder();

      const [a, b] = await Promise.all([
        transition(baristaToken, id, 'IN_PREPARATION'),
        transition(cashierToken, id, 'IN_PREPARATION'),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);

      const loser = [a, b].find((res) => res.status === 409);
      const problem = loser?.body as ProblemDetails;
      expect(problem.code).toBe('ORDER_INVALID_TRANSITION');
      // §9.1 puts the real status in meta so the losing screen can resync.
      expect(problem.meta).toEqual({
        currentStatus: 'IN_PREPARATION',
        requested: 'IN_PREPARATION',
      });

      const history = await harness.db
        .select()
        .from(schema.orderStatusHistory)
        .where(eq(schema.orderStatusHistory.orderId, id));
      expect(
        history.filter((row) => row.toStatus === 'IN_PREPARATION'),
      ).toHaveLength(1);
    });

    it('refuses a transition the state machine forbids', async () => {
      const res = await postOrder(kioskToken, kioskBasket());
      const { id } = res.body as OrderBody;

      const skipped = await transition(baristaToken, id, 'READY');

      expect(skipped.status).toBe(409);
      expect((skipped.body as ProblemDetails).meta).toEqual({
        currentStatus: 'PENDING_PAYMENT',
        requested: 'READY',
      });
    });

    /**
     * §4.4's standing rule: an order becomes paid because a payment succeeded,
     * never because somebody asked. The machine permits
     * PENDING_PAYMENT -> PAID; this door does not, and the refusal is a 409
     * about the transition rather than a 422 about the field (§8 puts
     * transition legality in the business layer).
     */
    it('will not let a barista mark an order paid', async () => {
      const res = await postOrder(kioskToken, kioskBasket());
      const { id } = res.body as OrderBody;

      const claimed = await transition(baristaToken, id, 'PAID');

      expect(claimed.status).toBe(409);
      expect((claimed.body as ProblemDetails).code).toBe(
        'ORDER_INVALID_TRANSITION',
      );

      const [row] = await harness.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, id));
      expect(row.status).toBe('PENDING_PAYMENT');
    });

    it('will not let a barista refund an order', async () => {
      const id = await paidOrder();

      const refunded = await transition(baristaToken, id, 'REFUNDED');

      expect(refunded.status).toBe(409);
      expect((refunded.body as ProblemDetails).code).toBe(
        'ORDER_INVALID_TRANSITION',
      );
    });

    it('refuses a status that is not in the enum', async () => {
      const id = await paidOrder();

      const res = await transition(baristaToken, id, 'DELICIOUS');

      expect(res.status).toBe(422);
      expect((res.body as ProblemDetails).code).toBe('VALIDATION_FAILED');
    });

    it('answers 404 for an order that does not exist', async () => {
      const res = await transition(baristaToken, uuidv7(), 'IN_PREPARATION');

      expect(res.status).toBe(404);
    });

    it('refuses a kiosk outright — no transition is a device"s (§6.4)', async () => {
      const id = await paidOrder();

      const res = await transition(kioskToken, id, 'IN_PREPARATION');

      expect(res.status).toBe(403);
      expect((res.body as ProblemDetails).code).toBe('FORBIDDEN_ROLE');
    });
  });

  /** `POST /orders/:id/cancel` (FR-8, §5.2). */
  describe('cancelling an order', () => {
    const cancel = (token: string, id: string, body = {}) =>
      harness
        .http()
        .post(`/api/v1/orders/${id}/cancel`)
        .set('Authorization', auth(token))
        .send(body);

    const pendingOrder = async (): Promise<string> => {
      const res = await postOrder(kioskToken, kioskBasket());
      expect(res.status).toBe(201);
      return (res.body as OrderBody).id;
    };

    it('lets the kiosk that placed it call it off', async () => {
      const id = await pendingOrder();

      const res = await cancel(kioskToken, id);

      expect(res.status).toBe(200);
      expect((res.body as OrderSummaryBody).status).toBe('CANCELLED');
    });

    it('lets a cashier cancel from the counter', async () => {
      const id = await pendingOrder();

      expect((await cancel(cashierToken, id)).status).toBe(200);
    });

    it('records the reason on the history row', async () => {
      const id = await pendingOrder();

      await cancel(cashierToken, id, { reason: 'customer changed their mind' });

      const history = await harness.db
        .select()
        .from(schema.orderStatusHistory)
        .where(eq(schema.orderStatusHistory.orderId, id));
      const cancelled = history.find((row) => row.toStatus === 'CANCELLED');

      expect(cancelled?.reason).toBe('customer changed their mind');
      // The moves that have no why keep a null rather than an empty string.
      expect(history.find((row) => row.fromStatus === null)?.reason).toBeNull();
    });

    /**
     * The clearing this phase could not otherwise exercise: an order that has
     * left PENDING_PAYMENT does not expire, so the column is emptied rather
     * than left as a date a screen would render as a countdown.
     */
    it('clears the expiry when the order leaves PENDING_PAYMENT', async () => {
      const id = await pendingOrder();

      const [before] = await harness.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, id));
      expect(before.expiresAt).not.toBeNull();

      await cancel(cashierToken, id);

      const [after] = await harness.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, id));
      expect(after.expiresAt).toBeNull();
    });

    it('refuses to cancel the same order twice', async () => {
      const id = await pendingOrder();
      await cancel(cashierToken, id);

      const again = await cancel(cashierToken, id);

      expect(again.status).toBe(409);
      expect((again.body as ProblemDetails).meta).toEqual({
        currentStatus: 'CANCELLED',
        requested: 'CANCELLED',
      });
    });

    /**
     * §5.2 gives a manager post-payment cancellation, and §4.4 routes it to
     * REFUNDED rather than CANCELLED. The refund it depends on is Phase 4, so
     * until then a paid order is refused — moving it to a terminal state while
     * the money sat with the gateway is the failure this design exists to
     * prevent.
     */
    it('refuses a paid order until refunds exist', async () => {
      const id = await pendingOrder();
      await harness.db
        .update(schema.orders)
        .set({ status: 'PAID' })
        .where(eq(schema.orders.id, id));

      const res = await cancel(managerToken, id, { reason: 'wrong drink' });

      expect(res.status).toBe(409);
      expect((res.body as ProblemDetails).code).toBe(
        'ORDER_INVALID_TRANSITION',
      );
    });

    it('will not let one device cancel another device"s order', async () => {
      const id = await pendingOrder();
      const other = await harness.createDevice('ACTIVE');

      const res = await cancel(other.token, id);

      // 404, not 403 — the same non-answer `GET /orders/:id` gives (§5.4).
      expect(res.status).toBe(404);

      const [row] = await harness.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, id));
      expect(row.status).toBe('PENDING_PAYMENT');
    });

    it('refuses a reason longer than §8 allows', async () => {
      const id = await pendingOrder();

      const res = await cancel(cashierToken, id, { reason: 'x'.repeat(201) });

      expect(res.status).toBe(422);
    });

    it('answers 404 for an order that does not exist', async () => {
      expect((await cancel(cashierToken, uuidv7())).status).toBe(404);
    });
  });

  /**
   * The expiry job (FR-10, §4.4, §9.3).
   *
   * Driven by calling the sweep directly rather than waiting on the cron: the
   * schedule is Nest's to get right, and a test that sleeps a minute to prove
   * it is a test nobody runs.
   */
  describe('expiring unpaid orders', () => {
    const expiryJob = () => harness.app.get(OrderExpiryService);

    /** An order already past its TTL, without waiting ten minutes for one. */
    const overdueOrder = async (): Promise<string> => {
      const res = await postOrder(kioskToken, kioskBasket());
      const { id } = res.body as OrderBody;
      await harness.db
        .update(schema.orders)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.orders.id, id));
      return id;
    };

    const statusOf = async (id: string) =>
      (
        await harness.db
          .select()
          .from(schema.orders)
          .where(eq(schema.orders.id, id))
      )[0].status;

    it('reclaims an order whose payment window has closed', async () => {
      const id = await overdueOrder();

      await expiryJob().expireOverdue();

      expect(await statusOf(id)).toBe('EXPIRED');
    });

    it('leaves an order that is still within its window', async () => {
      const res = await postOrder(kioskToken, kioskBasket());
      const { id } = res.body as OrderBody;

      await expiryJob().expireOverdue();

      expect(await statusOf(id)).toBe('PENDING_PAYMENT');
    });

    it('attributes the move to the system, not to a person (FR-22)', async () => {
      const id = await overdueOrder();

      await expiryJob().expireOverdue();

      const history = await harness.db
        .select()
        .from(schema.orderStatusHistory)
        .where(eq(schema.orderStatusHistory.orderId, id));
      const expired = history.find((row) => row.toStatus === 'EXPIRED');

      expect(expired).toMatchObject({
        fromStatus: 'PENDING_PAYMENT',
        actorType: 'SYSTEM',
        actorId: null,
      });
    });

    it('does not touch an order that was already paid', async () => {
      const id = await overdueOrder();
      await harness.db
        .update(schema.orders)
        .set({ status: 'PAID' })
        .where(eq(schema.orders.id, id));

      await expiryJob().expireOverdue();

      expect(await statusOf(id)).toBe('PAID');
    });

    /**
     * §9.3's "jobs are idempotent". Two instances (§11.3) both run this sweep
     * and neither coordinates with the other; the guarded transition is what
     * makes the second one a no-op rather than a second history row.
     */
    it('is safe to run twice over the same order', async () => {
      const id = await overdueOrder();

      await Promise.all([
        expiryJob().expireOverdue(),
        expiryJob().expireOverdue(),
      ]);

      const history = await harness.db
        .select()
        .from(schema.orderStatusHistory)
        .where(eq(schema.orderStatusHistory.orderId, id));

      expect(history.filter((row) => row.toStatus === 'EXPIRED')).toHaveLength(
        1,
      );
      expect(await statusOf(id)).toBe('EXPIRED');
    });
  });

  /**
   * Parked orders and checkout (FR-7, §4.5 B3, §5.2).
   *
   * B3's rule is the whole point: a queue number is claimed at checkout, not at
   * draft. A basket the customer is still deciding on must not consume a number
   * nobody calls, nor leave a gap in the day's sequence when it is abandoned.
   */
  describe('parking a counter order', () => {
    const park = (overrides: Record<string, unknown> = {}) =>
      postOrder(cashierToken, {
        channel: 'COUNTER',
        draft: true,
        items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
        ...overrides,
      });

    const checkout = (token: string, id: string) =>
      harness
        .http()
        .post(`/api/v1/orders/${id}/checkout`)
        .set('Authorization', auth(token))
        .send({});

    it('holds no queue number and no expiry while parked', async () => {
      const res = await park();

      expect(res.status).toBe(201);
      const order = res.body as OrderBody;
      expect(order.status).toBe('DRAFT');
      expect(order.orderNumber).toBeNull();
      expect(order.expiresAt).toBeNull();
    });

    it('is priced and snapshotted like any other order', async () => {
      const res = await park({
        items: [{ menuItemId: croissantId, quantity: 3, optionIds: [] }],
      });

      const order = res.body as OrderBody;
      expect(order.totalMinor).toBe(6000);
      expect(order.items[0].unitPriceMinor).toBe(2000);
    });

    it('claims a number and a payment window at checkout', async () => {
      const { id } = (await park()).body as OrderBody;

      const res = await checkout(cashierToken, id);

      expect(res.status).toBe(200);
      const order = res.body as OrderSummaryBody & { expiresAt: string | null };
      expect(order.status).toBe('PENDING_PAYMENT');
      expect(order.orderNumber).toMatch(/^A-\d{3,}$/);
      expect(order.expiresAt).not.toBeNull();
    });

    /**
     * The reason the column had to become nullable rather than carry a
     * placeholder: Postgres does not compare NULLs for uniqueness, so any
     * number of drafts coexist on a business day while two checked-out orders
     * still cannot share `A-042`.
     */
    it('lets several drafts sit on the same business day at once', async () => {
      const drafts = await Promise.all([park(), park(), park()]);

      expect(drafts.map((res) => res.status)).toEqual([201, 201, 201]);
      expect(
        drafts.every((res) => (res.body as OrderBody).orderNumber === null),
      ).toBe(true);
    });

    it('gives concurrent checkouts distinct numbers', async () => {
      const ids = await Promise.all(
        [1, 2, 3].map(async () => ((await park()).body as OrderBody).id),
      );

      const results = await Promise.all(
        ids.map((id) => checkout(cashierToken, id)),
      );

      const numbers = results.map(
        (res) => (res.body as OrderSummaryBody).orderNumber,
      );
      expect(new Set(numbers).size).toBe(3);
    });

    /**
     * B7: an order parked at 04:55 and checked out at 05:05 belongs to the
     * shift that took it. Recomputing the day here would move it into the next
     * day's sequence, where its number could collide with one already called.
     */
    it('keeps the business day it was parked on', async () => {
      const { id } = (await park()).body as OrderBody;
      await harness.db
        .update(schema.orders)
        .set({ businessDay: '2020-01-01' })
        .where(eq(schema.orders.id, id));

      const res = await checkout(cashierToken, id);

      expect((res.body as OrderSummaryBody).businessDay).toBe('2020-01-01');
    });

    it('records the checkout in the audit trail', async () => {
      const { id } = (await park()).body as OrderBody;
      await checkout(cashierToken, id);

      const history = await harness.db
        .select()
        .from(schema.orderStatusHistory)
        .where(eq(schema.orderStatusHistory.orderId, id));

      expect(
        history
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((row) => [row.fromStatus, row.toStatus]),
      ).toEqual([
        [null, 'DRAFT'],
        ['DRAFT', 'PENDING_PAYMENT'],
      ]);
    });

    it('refuses to check the same order out twice', async () => {
      const { id } = (await park()).body as OrderBody;
      await checkout(cashierToken, id);

      const again = await checkout(cashierToken, id);

      expect(again.status).toBe(409);
      expect((again.body as ProblemDetails).meta).toEqual({
        currentStatus: 'PENDING_PAYMENT',
        requested: 'PENDING_PAYMENT',
      });
    });

    it('can be cancelled while still parked', async () => {
      const { id } = (await park()).body as OrderBody;

      const res = await harness
        .http()
        .post(`/api/v1/orders/${id}/cancel`)
        .set('Authorization', auth(cashierToken))
        .send({ reason: 'customer left' });

      expect(res.status).toBe(200);
      expect((res.body as OrderSummaryBody).status).toBe('CANCELLED');
    });

    /** A draft has not reached payment, so FR-10's window does not apply. */
    it('is left alone by the expiry sweep', async () => {
      const { id } = (await park()).body as OrderBody;

      await harness.app.get(OrderExpiryService).expireOverdue();

      const [row] = await harness.db
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, id));
      expect(row.status).toBe('DRAFT');
    });

    /**
     * §4.4 keeps a kiosk cart on the tablet: a server-side row per browsing
     * customer is a table full of baskets nobody ever completes.
     */
    it('refuses a kiosk asking to park one', async () => {
      const res = await postOrder(kioskToken, kioskBasket({ draft: true }));

      expect(res.status).toBe(422);
      const problem = res.body as ProblemDetails;
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.[0].field).toBe('draft');
    });

    it('refuses to check out an order that was never a draft', async () => {
      const res = await postOrder(kioskToken, kioskBasket());
      const { id } = res.body as OrderBody;

      const checkedOut = await checkout(cashierToken, id);

      expect(checkedOut.status).toBe(409);
      expect((checkedOut.body as ProblemDetails).meta).toEqual({
        currentStatus: 'PENDING_PAYMENT',
        requested: 'PENDING_PAYMENT',
      });
    });

    it('answers 404 for an order that does not exist', async () => {
      expect((await checkout(cashierToken, uuidv7())).status).toBe(404);
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
