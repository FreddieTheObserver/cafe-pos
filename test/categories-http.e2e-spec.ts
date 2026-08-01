import { inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import * as schema from '../src/database/schema';
import { IdentityHarness } from './fixtures/identity-fixtures';

interface CategoryBody {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * The `/categories` HTTP contract (§5.2, §9.1).
 *
 * One suite rather than the http/service pair `/users` has: `UsersService`
 * carries the last-admin transaction, which is worth reaching directly, while
 * `CategoriesService` is thin enough that going through HTTP exercises all of
 * it — and does so through the validation pipe and error filter the clients
 * actually meet.
 */
describe('Category endpoints (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;

  /** Rows this suite made, so it can clean up without touching anyone else's. */
  const createdIds: string[] = [];

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;
  const categoryOf = (res: { body: unknown }): CategoryBody =>
    res.body as CategoryBody;

  /** Unique per call: `categories.name` is globally unique (§7.2). */
  const uniqueName = (label = 'Pastries') => `${label} ${uuidv7()}`;

  const create = (body: Record<string, unknown>) =>
    harness
      .http()
      .post('/api/v1/categories')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(body);

  const patch = (id: string, body: Record<string, unknown>) =>
    harness
      .http()
      .patch(`/api/v1/categories/${id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send(body);

  /** Creates a category and remembers it for teardown. */
  const seed = async (body: Record<string, unknown>): Promise<CategoryBody> => {
    const res = await create(body);
    if (res.status !== 201) {
      throw new Error(
        `fixture category failed with ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    const category = categoryOf(res);
    createdIds.push(category.id);
    return category;
  };

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    managerToken = await harness.accessTokenFor('MANAGER');
  });

  afterAll(async () => {
    try {
      if (createdIds.length > 0) {
        await harness.db
          .delete(schema.categories)
          .where(inArray(schema.categories.id, createdIds));
      }
    } finally {
      await harness.close();
    }
  });

  describe('POST /categories', () => {
    it('creates a category and answers 201', async () => {
      const name = uniqueName();

      const res = await create({ name, sortOrder: 3, isActive: false });
      if (res.status === 201) createdIds.push(categoryOf(res).id);

      expect(res.status).toBe(201);
      expect(categoryOf(res)).toMatchObject({
        name,
        sortOrder: 3,
        isActive: false,
      });
    });

    // The table defaults these; a back office form that only knows the name
    // should not have to invent the rest.
    it('applies the column defaults when only a name is sent', async () => {
      const category = await seed({ name: uniqueName() });

      expect(category).toMatchObject({ sortOrder: 0, isActive: true });
    });

    it('reports a taken name as 409 CATEGORY_NAME_EXISTS', async () => {
      const name = uniqueName();
      await seed({ name });

      const res = await create({ name });

      expect(res.status).toBe(409);
      expect(problemOf(res).code).toBe('CATEGORY_NAME_EXISTS');
      expect(problemOf(res).meta).toEqual({ name });
    });

    it('trims the name before storing it', async () => {
      const name = uniqueName();

      const category = await seed({ name: `  ${name}  ` });

      expect(category.name).toBe(name);
    });

    it('rejects an empty name', async () => {
      const res = await create({ name: '   ' });

      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0].field).toBe('name');
    });

    it('rejects a negative sort order', async () => {
      const res = await create({ name: uniqueName(), sortOrder: -1 });

      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0].field).toBe('sortOrder');
    });

    it('rejects a non-integer sort order', async () => {
      const res = await create({ name: uniqueName(), sortOrder: 1.5 });

      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0].field).toBe('sortOrder');
    });

    // strictObject: an unknown key is a client that thinks this endpoint takes
    // a field it does not, and answering 201 would hide that.
    it('rejects an unknown key', async () => {
      const res = await create({ name: uniqueName(), colour: 'blue' });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /categories', () => {
    const list = () =>
      harness
        .http()
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${managerToken}`);

    it('orders by sort order, then by name to break ties', async () => {
      // A shared prefix makes the alphabetical tiebreak predictable, and keeps
      // these three findable among whatever else the database holds.
      const prefix = `sort-${uuidv7()}`;
      await seed({ name: `${prefix}-zebra`, sortOrder: 1 });
      await seed({ name: `${prefix}-middle`, sortOrder: 5 });
      await seed({ name: `${prefix}-alpha`, sortOrder: 1 });

      const res = await list();

      expect(res.status).toBe(200);
      const mine = (res.body as CategoryBody[])
        .filter((row) => row.name.startsWith(prefix))
        .map((row) => row.name);
      expect(mine).toEqual([
        `${prefix}-alpha`,
        `${prefix}-zebra`,
        `${prefix}-middle`,
      ]);
    });

    // The back office cannot reactivate what it cannot see. This is the whole
    // reason the route exists next to `GET /menu` rather than inside it.
    it('includes inactive categories', async () => {
      const hidden = await seed({ name: uniqueName(), isActive: false });

      const res = await list();

      expect(res.body as CategoryBody[]).toContainEqual(
        expect.objectContaining({ id: hidden.id, isActive: false }),
      );
    });
  });

  describe('PATCH /categories/:id', () => {
    it('updates a mutable field', async () => {
      const category = await seed({ name: uniqueName() });
      const renamed = uniqueName('Renamed');

      const res = await patch(category.id, { name: renamed, sortOrder: 9 });

      expect(res.status).toBe(200);
      expect(categoryOf(res)).toMatchObject({ name: renamed, sortOrder: 9 });
    });

    it('reports a rename onto a taken name as 409', async () => {
      const taken = await seed({ name: uniqueName() });
      const mine = await seed({ name: uniqueName() });

      const res = await patch(mine.id, { name: taken.name });

      expect(res.status).toBe(409);
      expect(problemOf(res).code).toBe('CATEGORY_NAME_EXISTS');
    });

    // §8: an empty PATCH is a client bug; a 200 would hide it.
    it('rejects a body with no mutable field', async () => {
      const category = await seed({ name: uniqueName() });

      const res = await patch(category.id, {});

      expect(res.status).toBe(422);
    });

    it('answers 404 for a well-formed id nobody holds', async () => {
      const res = await patch(uuidv7(), { name: uniqueName() });

      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('rejects an id that is not a UUID with the validation envelope', async () => {
      const res = await harness
        .http()
        .patch('/api/v1/categories/not-a-uuid')
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ name: uniqueName() });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });
  });
});
