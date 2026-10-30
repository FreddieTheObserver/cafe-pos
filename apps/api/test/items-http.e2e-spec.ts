import { inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import * as schema from '../src/database/schema';
import { IdentityHarness } from './fixtures/identity-fixtures';

interface ItemBody {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  basePriceMinor: number;
  imageUrl: string | null;
  isAvailable: boolean;
  sortOrder: number;
}

/** The `/items` HTTP contract (§5.2, §9.1), including the FR-3 86 switch. */
describe('Menu item endpoints (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;
  let baristaToken: string;
  let categoryId: string;

  const itemIds: string[] = [];
  const categoryIds: string[] = [];

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;
  const itemOf = (res: { body: unknown }): ItemBody => res.body as ItemBody;

  const create = (body: Record<string, unknown>) =>
    harness
      .http()
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(body);

  const patch = (id: string, body: Record<string, unknown>) =>
    harness
      .http()
      .patch(`/api/v1/items/${id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send(body);

  const setAvailability = (
    id: string,
    body: Record<string, unknown>,
    token = baristaToken,
  ) =>
    harness
      .http()
      .patch(`/api/v1/items/${id}/availability`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const newItem = (overrides: Record<string, unknown> = {}) => ({
    categoryId,
    name: `Iced Latte ${uuidv7()}`,
    basePriceMinor: 9500,
    ...overrides,
  });

  /** Creates an item and remembers it for teardown. */
  const seed = async (
    overrides: Record<string, unknown> = {},
  ): Promise<ItemBody> => {
    const res = await create(newItem(overrides));
    if (res.status !== 201) {
      throw new Error(
        `fixture item failed with ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    const item = itemOf(res);
    itemIds.push(item.id);
    return item;
  };

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    managerToken = await harness.accessTokenFor('MANAGER');
    baristaToken = await harness.accessTokenFor('BARISTA');

    const category = await harness
      .http()
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ name: `Drinks ${uuidv7()}` });
    categoryId = (category.body as { id: string }).id;
    categoryIds.push(categoryId);
  });

  afterAll(async () => {
    try {
      // Items reference categories, so they go first or the FK trips.
      if (itemIds.length > 0) {
        await harness.db
          .delete(schema.menuItems)
          .where(inArray(schema.menuItems.id, itemIds));
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

  describe('POST /items', () => {
    it('creates an item and answers 201', async () => {
      const item = await seed({ basePriceMinor: 12000, sortOrder: 2 });

      expect(item).toMatchObject({
        categoryId,
        basePriceMinor: 12000,
        sortOrder: 2,
      });
    });

    it('applies the column defaults when only the required fields are sent', async () => {
      const item = await seed();

      expect(item).toMatchObject({
        description: null,
        imageUrl: null,
        isAvailable: true,
        sortOrder: 0,
      });
    });

    // Staging a seasonal item before it goes on sale is a real workflow, so
    // creation may set this even though `PATCH /items/:id` may not.
    it('accepts an item staged as unavailable', async () => {
      const item = await seed({ isAvailable: false });

      expect(item.isAvailable).toBe(false);
    });

    it('reports an unknown category as 422 CATEGORY_UNKNOWN', async () => {
      const unknown = uuidv7();

      const res = await create(newItem({ categoryId: unknown }));

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('CATEGORY_UNKNOWN');
      expect(problemOf(res).meta).toEqual({ categoryId: unknown });
    });

    it('accepts an https image URL', async () => {
      const imageUrl = 'https://cdn.cafepos.test/items/abc123.webp';

      const item = await seed({ imageUrl });

      expect(item.imageUrl).toBe(imageUrl);
    });

    // The value is rendered as an image source by unattended kiosks, so a
    // scheme that can execute is a stored-XSS path onto a public tablet.
    it.each([
      ['javascript:alert(1)'],
      ['data:text/html;base64,PHNjcmlwdD4='],
      ['http://cdn.cafepos.test/insecure.webp'],
    ])('rejects %s as an image URL', async (imageUrl) => {
      const res = await create(newItem({ imageUrl }));

      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0].field).toBe('imageUrl');
    });

    it('rejects a negative price', async () => {
      const res = await create(newItem({ basePriceMinor: -1 }));

      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0].field).toBe('basePriceMinor');
    });

    it('rejects a fractional price', async () => {
      const res = await create(newItem({ basePriceMinor: 95.5 }));

      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0].field).toBe('basePriceMinor');
    });

    it('rejects an unknown key', async () => {
      const res = await create(newItem({ calories: 120 }));

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /items', () => {
    it('includes 86ed items so the back office can un-86 them', async () => {
      const hidden = await seed({ isAvailable: false });

      const res = await harness
        .http()
        .get('/api/v1/items')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body as ItemBody[]).toContainEqual(
        expect.objectContaining({ id: hidden.id, isAvailable: false }),
      );
    });
  });

  describe('PATCH /items/:id', () => {
    it('updates price and name', async () => {
      const item = await seed();

      const res = await patch(item.id, {
        name: 'Repriced Latte',
        basePriceMinor: 10500,
      });

      expect(res.status).toBe(200);
      expect(itemOf(res)).toMatchObject({
        name: 'Repriced Latte',
        basePriceMinor: 10500,
      });
    });

    it('clears a description with an explicit null', async () => {
      const item = await seed({ description: 'Seasonal' });
      expect(item.description).toBe('Seasonal');

      const res = await patch(item.id, { description: null });

      expect(res.status).toBe(200);
      expect(itemOf(res).description).toBeNull();
    });

    it('moves an item to another category', async () => {
      const item = await seed();
      const other = await harness
        .http()
        .post('/api/v1/categories')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: `Pastries ${uuidv7()}` });
      const otherId = (other.body as { id: string }).id;
      categoryIds.push(otherId);

      const res = await patch(item.id, { categoryId: otherId });

      expect(res.status).toBe(200);
      expect(itemOf(res).categoryId).toBe(otherId);
    });

    it('reports a move to an unknown category as 422 CATEGORY_UNKNOWN', async () => {
      const item = await seed();

      const res = await patch(item.id, { categoryId: uuidv7() });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('CATEGORY_UNKNOWN');
    });

    /**
     * The deliberate asymmetry: §5.2 scopes this route to price/name/photo/
     * category, and availability has its own separately-authorized route. If
     * this ever starts answering 200, a manager has gained a second way to 86
     * an item and Phase 5 has a second place to remember the FR-3 event.
     */
    it('refuses to change availability through the general update', async () => {
      const item = await seed();

      const res = await patch(item.id, { isAvailable: false });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('rejects a body with no mutable field', async () => {
      const item = await seed();

      const res = await patch(item.id, {});

      expect(res.status).toBe(422);
    });

    it('answers 404 for a well-formed id nobody holds', async () => {
      const res = await patch(uuidv7(), { name: 'Ghost' });

      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('PATCH /items/:id/availability', () => {
    // FR-3, and the reason this route exists apart from the one above: the
    // barista token here holds no rights to reprice anything.
    it('lets a barista 86 an item', async () => {
      const item = await seed();

      const res = await setAvailability(item.id, { isAvailable: false });

      expect(res.status).toBe(200);
      expect(itemOf(res).isAvailable).toBe(false);
    });

    it('lets a barista un-86 an item', async () => {
      const item = await seed({ isAvailable: false });

      const res = await setAvailability(item.id, { isAvailable: true });

      expect(res.status).toBe(200);
      expect(itemOf(res).isAvailable).toBe(true);
    });

    it('answers 404 for a well-formed id nobody holds', async () => {
      const res = await setAvailability(uuidv7(), { isAvailable: false });

      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('requires the flag', async () => {
      const item = await seed();

      const res = await setAvailability(item.id, {});

      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0].field).toBe('isAvailable');
    });

    // One field, because it is one decision — smuggling a price change through
    // the route baristas can reach would be a privilege escalation.
    it('rejects any other field', async () => {
      const item = await seed();

      const res = await setAvailability(item.id, {
        isAvailable: false,
        basePriceMinor: 1,
      });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });
  });
});
