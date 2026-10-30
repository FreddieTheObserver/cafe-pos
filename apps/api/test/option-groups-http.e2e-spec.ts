import { inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import * as schema from '../src/database/schema';
import { IdentityHarness } from './fixtures/identity-fixtures';

interface GroupBody {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
}

interface OptionBody {
  id: string;
  optionGroupId: string;
  name: string;
  priceDeltaMinor: number;
  isDefault: boolean;
  isAvailable: boolean;
}

interface AttachedGroupBody extends GroupBody {
  sortOrder: number;
}

/**
 * The `/option-groups`, `/options` and `/items/:id/option-groups` contracts
 * (§5.2, §9.1).
 */
describe('Option group endpoints (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;
  let baristaToken: string;
  let categoryId: string;

  const groupIds: string[] = [];
  const itemIds: string[] = [];
  const categoryIds: string[] = [];

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;
  const groupOf = (res: { body: unknown }): GroupBody => res.body as GroupBody;
  const optionOf = (res: { body: unknown }): OptionBody =>
    res.body as OptionBody;

  const auth = (token = managerToken) => `Bearer ${token}`;

  const createGroup = (body: Record<string, unknown>) =>
    harness
      .http()
      .post('/api/v1/option-groups')
      .set('Authorization', auth())
      .send(body);

  const patchGroup = (id: string, body: Record<string, unknown>) =>
    harness
      .http()
      .patch(`/api/v1/option-groups/${id}`)
      .set('Authorization', auth())
      .send(body);

  const createOption = (groupId: string, body: Record<string, unknown>) =>
    harness
      .http()
      .post(`/api/v1/option-groups/${groupId}/options`)
      .set('Authorization', auth())
      .send(body);

  const patchOption = (id: string, body: Record<string, unknown>) =>
    harness
      .http()
      .patch(`/api/v1/options/${id}`)
      .set('Authorization', auth())
      .send(body);

  const setOptionAvailability = (id: string, body: Record<string, unknown>) =>
    harness
      .http()
      .patch(`/api/v1/options/${id}/availability`)
      .set('Authorization', auth(baristaToken))
      .send(body);

  const setItemGroups = (itemId: string, body: Record<string, unknown>) =>
    harness
      .http()
      .put(`/api/v1/items/${itemId}/option-groups`)
      .set('Authorization', auth())
      .send(body);

  /** Creates a group and remembers it for teardown. */
  const seedGroup = async (
    body: Record<string, unknown> = {},
  ): Promise<GroupBody> => {
    const res = await createGroup({ name: `Size ${uuidv7()}`, ...body });
    if (res.status !== 201) {
      throw new Error(
        `fixture group failed with ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    const group = groupOf(res);
    groupIds.push(group.id);
    return group;
  };

  const seedOption = async (
    groupId: string,
    body: Record<string, unknown> = {},
  ): Promise<OptionBody> => {
    const res = await createOption(groupId, {
      name: `Large ${uuidv7()}`,
      ...body,
    });
    if (res.status !== 201) {
      throw new Error(
        `fixture option failed with ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    // No id tracked: options cascade when their group goes.
    return optionOf(res);
  };

  const seedItem = async (): Promise<string> => {
    const res = await harness
      .http()
      .post('/api/v1/items')
      .set('Authorization', auth())
      .send({
        categoryId,
        name: `Latte ${uuidv7()}`,
        basePriceMinor: 9500,
      });
    if (res.status !== 201) {
      throw new Error(
        `fixture item failed with ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    const id = (res.body as { id: string }).id;
    itemIds.push(id);
    return id;
  };

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    managerToken = await harness.accessTokenFor('MANAGER');
    baristaToken = await harness.accessTokenFor('BARISTA');

    const category = await harness
      .http()
      .post('/api/v1/categories')
      .set('Authorization', auth())
      .send({ name: `Drinks ${uuidv7()}` });
    categoryId = (category.body as { id: string }).id;
    categoryIds.push(categoryId);
  });

  afterAll(async () => {
    try {
      // Join rows cascade from either side, and options cascade from their
      // group, so removing items and groups clears everything below them.
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

  describe('POST /option-groups', () => {
    it('applies the column defaults', async () => {
      const group = await seedGroup();

      expect(group).toMatchObject({ minSelect: 0, maxSelect: 1 });
    });

    it('creates a group with explicit bounds', async () => {
      const group = await seedGroup({ minSelect: 0, maxSelect: 5 });

      expect(group).toMatchObject({ minSelect: 0, maxSelect: 5 });
    });

    it('rejects minSelect above maxSelect', async () => {
      const res = await createGroup({
        name: `Bad ${uuidv7()}`,
        minSelect: 3,
        maxSelect: 2,
      });

      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0].field).toBe('minSelect');
    });

    /**
     * The schema's fallbacks have to match the column defaults, or a request
     * this validator called fine gets refused by the CHECK constraint instead.
     * `maxSelect` defaults to 1, so a minimum of 3 is unsatisfiable even though
     * the body never mentions a maximum.
     */
    it('judges a lone minSelect against the default maxSelect', async () => {
      const res = await createGroup({ name: `Bad ${uuidv7()}`, minSelect: 3 });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('rejects an unknown key', async () => {
      const res = await createGroup({
        name: `Odd ${uuidv7()}`,
        required: true,
      });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /option-groups', () => {
    it('nests each group’s options, ordered by name', async () => {
      const group = await seedGroup();
      const prefix = `opt-${uuidv7()}`;
      await seedOption(group.id, { name: `${prefix}-zulu` });
      await seedOption(group.id, { name: `${prefix}-alpha` });

      const res = await harness
        .http()
        .get('/api/v1/option-groups')
        .set('Authorization', auth());

      expect(res.status).toBe(200);
      const mine = (res.body as (GroupBody & { options: OptionBody[] })[]).find(
        (row) => row.id === group.id,
      );
      expect(mine?.options.map((option) => option.name)).toEqual([
        `${prefix}-alpha`,
        `${prefix}-zulu`,
      ]);
    });
  });

  describe('PATCH /option-groups/:id', () => {
    it('updates the bounds', async () => {
      const group = await seedGroup({ minSelect: 0, maxSelect: 1 });

      const res = await patchGroup(group.id, { minSelect: 1, maxSelect: 3 });

      expect(res.status).toBe(200);
      expect(groupOf(res)).toMatchObject({ minSelect: 1, maxSelect: 3 });
    });

    it('rejects minSelect above maxSelect when both are sent', async () => {
      const group = await seedGroup();

      const res = await patchGroup(group.id, { minSelect: 4, maxSelect: 2 });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });

    /**
     * The case the DTO structurally cannot see: only `maxSelect` is in the
     * body, and the `minSelect` it would violate is in the database. The CHECK
     * constraint is what catches it, and this asserts it arrives as the
     * documented 422 rather than a 500 from an unhandled driver error.
     */
    it('reports a bound moved past its stored partner as OPTION_GROUP_MINMAX_INVALID', async () => {
      const group = await seedGroup({ minSelect: 1, maxSelect: 3 });

      const res = await patchGroup(group.id, { maxSelect: 0 });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('OPTION_GROUP_MINMAX_INVALID');
    });

    it('rejects a body with no mutable field', async () => {
      const group = await seedGroup();

      const res = await patchGroup(group.id, {});

      expect(res.status).toBe(422);
    });

    it('answers 404 for a well-formed id nobody holds', async () => {
      const res = await patchGroup(uuidv7(), { name: 'Ghost' });

      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('POST /option-groups/:id/options', () => {
    it('applies the column defaults', async () => {
      const group = await seedGroup();

      const option = await seedOption(group.id);

      expect(option).toMatchObject({
        optionGroupId: group.id,
        priceDeltaMinor: 0,
        isDefault: false,
        isAvailable: true,
      });
    });

    // No CHECK on `price_delta_minor`, unlike an item's base price: "small
    // size, -10 THB" is a real menu. Phase 3's pricing is what has to keep a
    // line total from going negative.
    it('accepts a negative price delta', async () => {
      const group = await seedGroup();

      const option = await seedOption(group.id, { priceDeltaMinor: -1000 });

      expect(option.priceDeltaMinor).toBe(-1000);
    });

    // The missing thing is the resource the URL addresses, not a value in the
    // body — so 404 here, where an item's unknown category was a 422.
    it('answers 404 for an unknown group', async () => {
      const res = await createOption(uuidv7(), { name: 'Orphan' });

      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('PATCH /options/:id', () => {
    it('updates the price delta', async () => {
      const group = await seedGroup();
      const option = await seedOption(group.id);

      const res = await patchOption(option.id, { priceDeltaMinor: 2000 });

      expect(res.status).toBe(200);
      expect(optionOf(res).priceDeltaMinor).toBe(2000);
    });

    // Same asymmetry as items: 86ing is separately authorized from repricing,
    // so it cannot be reachable through the manager-only route.
    it('refuses to change availability through the general update', async () => {
      const group = await seedGroup();
      const option = await seedOption(group.id);

      const res = await patchOption(option.id, { isAvailable: false });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('answers 404 for a well-formed id nobody holds', async () => {
      const res = await patchOption(uuidv7(), { name: 'Ghost' });

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /options/:id/availability', () => {
    // FR-3's headline case, and the barista token proves it needs no manager.
    it('lets a barista 86 the oat milk', async () => {
      const group = await seedGroup();
      const option = await seedOption(group.id);

      const res = await setOptionAvailability(option.id, {
        isAvailable: false,
      });

      expect(res.status).toBe(200);
      expect(optionOf(res).isAvailable).toBe(false);
    });

    it('rejects any other field', async () => {
      const group = await seedGroup();
      const option = await seedOption(group.id);

      const res = await setOptionAvailability(option.id, {
        isAvailable: false,
        priceDeltaMinor: 1,
      });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('answers 404 for a well-formed id nobody holds', async () => {
      const res = await setOptionAvailability(uuidv7(), { isAvailable: false });

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /items/:id/option-groups', () => {
    it('attaches groups in the order given', async () => {
      const itemId = await seedItem();
      const size = await seedGroup();
      const milk = await seedGroup();

      const res = await setItemGroups(itemId, {
        optionGroupIds: [milk.id, size.id],
      });

      expect(res.status).toBe(200);
      expect(res.body as AttachedGroupBody[]).toEqual([
        expect.objectContaining({ id: milk.id, sortOrder: 0 }),
        expect.objectContaining({ id: size.id, sortOrder: 1 }),
      ]);
    });

    // "Idempotent replace" (§5.2): the same body always leaves the same rows,
    // so a back office retrying a timed-out save cannot double-attach.
    it('leaves the same rows when replayed', async () => {
      const itemId = await seedItem();
      const group = await seedGroup();
      const body = { optionGroupIds: [group.id] };

      const first = await setItemGroups(itemId, body);
      const second = await setItemGroups(itemId, body);

      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
    });

    it('replaces the previous set rather than adding to it', async () => {
      const itemId = await seedItem();
      const first = await seedGroup();
      const second = await seedGroup();

      await setItemGroups(itemId, { optionGroupIds: [first.id] });
      const res = await setItemGroups(itemId, { optionGroupIds: [second.id] });

      expect(res.status).toBe(200);
      expect(res.body as AttachedGroupBody[]).toEqual([
        expect.objectContaining({ id: second.id, sortOrder: 0 }),
      ]);
    });

    // A croissant has no decisions attached to it.
    it('accepts an empty list as "detach everything"', async () => {
      const itemId = await seedItem();
      const group = await seedGroup();
      await setItemGroups(itemId, { optionGroupIds: [group.id] });

      const res = await setItemGroups(itemId, { optionGroupIds: [] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('reports every unknown group id at once', async () => {
      const itemId = await seedItem();
      const real = await seedGroup();
      const ghosts = [uuidv7(), uuidv7()];

      const res = await setItemGroups(itemId, {
        optionGroupIds: [real.id, ...ghosts],
      });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('OPTION_GROUP_UNKNOWN');
      expect(problemOf(res).meta).toEqual({ optionGroupIds: ghosts });
    });

    it('rejects a repeated group id', async () => {
      const itemId = await seedItem();
      const group = await seedGroup();

      const res = await setItemGroups(itemId, {
        optionGroupIds: [group.id, group.id],
      });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('answers 404 for an item nobody holds', async () => {
      const res = await setItemGroups(uuidv7(), { optionGroupIds: [] });

      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });
  });
});
