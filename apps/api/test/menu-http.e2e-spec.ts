import { inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { REDIS } from '../src/redis/redis.constants';
import { IdentityHarness } from './fixtures/identity-fixtures';

interface MenuOptionBody {
  id: string;
  name: string;
  priceDeltaMinor: number;
  isDefault: boolean;
  isAvailable: boolean;
}

interface MenuGroupBody {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  options: MenuOptionBody[];
}

interface MenuItemBody {
  id: string;
  name: string;
  isAvailable: boolean;
  basePriceMinor: number;
  optionGroups: MenuGroupBody[];
}

interface MenuCategoryBody {
  id: string;
  name: string;
  sortOrder: number;
  items: MenuItemBody[];
}

interface MenuBody {
  categories: MenuCategoryBody[];
}

/**
 * `GET /menu` (FR-4, §5.2) — the composite read, its ETag/304 polling contract,
 * and the invalidation that makes FR-3's 10-second budget reachable.
 *
 * This is Phase 2's exit criterion: everything a kiosk needs to render a screen
 * arrives in one request.
 */
describe('Menu endpoint (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;
  let baristaToken: string;
  let kioskToken: string;

  /** The fixture menu, built once and asserted against throughout. */
  let visibleCategoryId: string;
  let hiddenCategoryId: string;
  let latteId: string;
  let soldOutItemId: string;
  let ghostItemId: string;
  let sizeGroupId: string;
  let milkGroupId: string;
  let oatMilkId: string;

  const itemIds: string[] = [];
  const groupIds: string[] = [];
  const categoryIds: string[] = [];

  const auth = (token = managerToken) => `Bearer ${token}`;

  const getMenu = (token = kioskToken, ifNoneMatch?: string) => {
    const call = harness
      .http()
      .get('/api/v1/menu')
      .set('Authorization', auth(token));
    return ifNoneMatch === undefined
      ? call
      : call.set('If-None-Match', ifNoneMatch);
  };

  const menuOf = (res: { body: unknown }): MenuBody => res.body as MenuBody;

  /** This suite's category, found by id among whatever else the database holds. */
  const myCategory = (res: { body: unknown }): MenuCategoryBody | undefined =>
    menuOf(res).categories.find((row) => row.id === visibleCategoryId);

  const post = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<string> => {
    const res = await harness
      .http()
      .post(path)
      .set('Authorization', auth())
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
    baristaToken = await harness.accessTokenFor('BARISTA');
    kioskToken = (await harness.createDevice('ACTIVE')).token;

    visibleCategoryId = await post('/api/v1/categories', {
      name: `Drinks ${uuidv7()}`,
      sortOrder: 0,
    });
    hiddenCategoryId = await post('/api/v1/categories', {
      name: `Retired ${uuidv7()}`,
      isActive: false,
    });
    categoryIds.push(visibleCategoryId, hiddenCategoryId);

    latteId = await post('/api/v1/items', {
      categoryId: visibleCategoryId,
      name: `Latte ${uuidv7()}`,
      basePriceMinor: 9500,
      sortOrder: 0,
    });
    soldOutItemId = await post('/api/v1/items', {
      categoryId: visibleCategoryId,
      name: `Croissant ${uuidv7()}`,
      basePriceMinor: 6000,
      sortOrder: 1,
      isAvailable: false,
    });
    ghostItemId = await post('/api/v1/items', {
      categoryId: hiddenCategoryId,
      name: `Discontinued ${uuidv7()}`,
      basePriceMinor: 100,
    });
    itemIds.push(latteId, soldOutItemId, ghostItemId);

    sizeGroupId = await post('/api/v1/option-groups', {
      name: `Size ${uuidv7()}`,
      minSelect: 1,
      maxSelect: 1,
    });
    milkGroupId = await post('/api/v1/option-groups', {
      name: `Milk ${uuidv7()}`,
    });
    groupIds.push(sizeGroupId, milkGroupId);

    await post(`/api/v1/option-groups/${sizeGroupId}/options`, {
      name: 'Large',
      priceDeltaMinor: 2000,
    });
    oatMilkId = await post(`/api/v1/option-groups/${milkGroupId}/options`, {
      name: 'Oat milk',
      priceDeltaMinor: 1500,
    });

    // Milk first, Size second — deliberately not creation order, so the
    // response proves it carries the attachment's order rather than the ids'.
    const attach = await harness
      .http()
      .put(`/api/v1/items/${latteId}/option-groups`)
      .set('Authorization', auth())
      .send({ optionGroupIds: [milkGroupId, sizeGroupId] });
    if (attach.status !== 200) {
      throw new Error(`fixture attach failed with ${attach.status}`);
    }
  });

  afterAll(async () => {
    try {
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

  describe('the composite document', () => {
    it('serves the whole tree to a kiosk in one call', async () => {
      const res = await getMenu();

      expect(res.status).toBe(200);

      const latte = myCategory(res)?.items.find((row) => row.id === latteId);
      expect(latte).toBeDefined();

      // Attachment order, not creation order: Milk was attached first.
      expect(latte?.optionGroups.map((group) => group.id)).toEqual([
        milkGroupId,
        sizeGroupId,
      ]);
      expect(latte?.optionGroups[0]).toMatchObject({
        sortOrder: 0,
        minSelect: 0,
        maxSelect: 1,
      });
      expect(latte?.optionGroups[0].options).toContainEqual(
        expect.objectContaining({
          id: oatMilkId,
          priceDeltaMinor: 1500,
          isAvailable: true,
        }),
      );
    });

    /**
     * The two flags mean different things. A category's `isActive` is a publish
     * switch — an inactive one is not part of the menu at all, and neither are
     * the items filed under it.
     */
    it('omits an inactive category and everything under it', async () => {
      const res = await getMenu();

      const ids = menuOf(res).categories.map((row) => row.id);
      expect(ids).not.toContain(hiddenCategoryId);

      const everyItemId = menuOf(res).categories.flatMap((category) =>
        category.items.map((item) => item.id),
      );
      expect(everyItemId).not.toContain(ghostItemId);
    });

    /**
     * `isAvailable` is a stock switch, so the row stays and carries the flag: a
     * kiosk rendering "Sold out" beats one where the customer's usual drink
     * silently vanished.
     */
    it('keeps a 86ed item in the document, flagged', async () => {
      const res = await getMenu();

      expect(myCategory(res)?.items).toContainEqual(
        expect.objectContaining({ id: soldOutItemId, isAvailable: false }),
      );
    });

    it('is readable by staff as well as kiosks', async () => {
      const res = await getMenu(managerToken);

      expect(res.status).toBe(200);
      expect(myCategory(res)).toBeDefined();
    });
  });

  describe('the polling contract', () => {
    it('answers with an ETag and a revalidate-always Cache-Control', async () => {
      const res = await getMenu();

      expect(res.headers.etag).toMatch(/^W\/"catalog-\d+"$/);
      expect(res.headers['cache-control']).toBe('private, no-cache');
    });

    // The whole point of the design: a kiosk polling every 10 seconds pays for
    // one Redis read, not a menu render.
    it('answers 304 with no body when the client is current', async () => {
      const first = await getMenu();

      const second = await getMenu(kioskToken, first.headers.etag);

      expect(second.status).toBe(304);
      expect(second.text).toBeFalsy();
    });

    it('answers 200 when the client holds a stale ETag', async () => {
      const res = await getMenu(kioskToken, 'W/"catalog-0"');

      expect(res.status).toBe(200);
      expect(myCategory(res)).toBeDefined();
    });

    it('does not move the version on a read', async () => {
      const first = await getMenu();
      const second = await getMenu();

      expect(second.headers.etag).toBe(first.headers.etag);
    });

    /**
     * Proves Redis is actually on the read path.
     *
     * Every other assertion in this file passes whether the cache works or is
     * dead code, because Postgres returns the same document either way — so
     * none of them can tell the difference. This one plants a value in Redis
     * that the database cannot produce: if the response still carries it, the
     * response came from the cache.
     */
    it('serves the cached document instead of rebuilding it', async () => {
      const redis = harness.app.get<Redis>(REDIS);
      const served = await getMenu();
      const version = /catalog-(\d+)/.exec(served.headers.etag)?.[1];
      expect(version).toBeDefined();

      const key = `catalog:menu:v${version}`;
      // The write half: what was served is what got stored.
      expect(await redis.get(key)).toBe(served.text);

      const poisoned = JSON.stringify({ categories: [], fromCache: true });
      await redis.set(key, poisoned);
      const next = await getMenu();

      expect((next.body as { fromCache?: boolean }).fromCache).toBe(true);

      // Drop it rather than restore it: the version has not moved, so the next
      // read misses, rebuilds from Postgres, and re-caches the real document.
      await redis.del(key);
      expect((await getMenu()).body).toEqual(served.body);
    });
  });

  describe('invalidation', () => {
    /**
     * FR-3's 10-second budget: the kiosk's next poll has to see the change.
     * Anything that can alter the document has to move the version, which is
     * why the bump lives on an interceptor covering every catalog write rather
     * than in each service method.
     */
    it('changes the ETag when an item is 86ed, and reflects it', async () => {
      const before = await getMenu();

      const toggle = await harness
        .http()
        .patch(`/api/v1/items/${latteId}/availability`)
        .set('Authorization', auth(baristaToken))
        .send({ isAvailable: false });
      expect(toggle.status).toBe(200);

      const after = await getMenu();

      expect(after.headers.etag).not.toBe(before.headers.etag);
      expect(after.status).toBe(200);
      expect(
        myCategory(after)?.items.find((row) => row.id === latteId)?.isAvailable,
      ).toBe(false);

      // Put it back so later assertions see the fixture as built.
      await harness
        .http()
        .patch(`/api/v1/items/${latteId}/availability`)
        .set('Authorization', auth(baristaToken))
        .send({ isAvailable: true });
    });

    it('changes the ETag when an option is 86ed, and reflects it', async () => {
      const before = await getMenu();

      await harness
        .http()
        .patch(`/api/v1/options/${oatMilkId}/availability`)
        .set('Authorization', auth(baristaToken))
        .send({ isAvailable: false });

      const after = await getMenu();

      expect(after.headers.etag).not.toBe(before.headers.etag);
      const milkGroup = myCategory(after)
        ?.items.find((row) => row.id === latteId)
        ?.optionGroups.find((group) => group.id === milkGroupId);
      expect(milkGroup?.options).toContainEqual(
        expect.objectContaining({ id: oatMilkId, isAvailable: false }),
      );
    });

    it('changes the ETag when a category is renamed', async () => {
      const before = await getMenu();

      await harness
        .http()
        .patch(`/api/v1/categories/${visibleCategoryId}`)
        .set('Authorization', auth())
        .send({ name: `Renamed ${uuidv7()}` });

      const after = await getMenu();

      expect(after.headers.etag).not.toBe(before.headers.etag);
    });

    // A rejected write must not invalidate: the document did not change, and
    // burning the version would cost every kiosk a needless re-download.
    it('leaves the version alone when a write is rejected', async () => {
      const before = await getMenu();

      const rejected = await harness
        .http()
        .post('/api/v1/items')
        .set('Authorization', auth())
        .send({ categoryId: uuidv7(), name: 'Orphan', basePriceMinor: 1 });
      expect(rejected.status).toBe(422);

      const after = await getMenu();

      expect(after.headers.etag).toBe(before.headers.etag);
    });
  });
});
