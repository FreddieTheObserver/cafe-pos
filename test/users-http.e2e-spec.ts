import { uuidv7 } from 'uuidv7';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import {
  FIXTURE_PASSWORD,
  IdentityHarness,
} from './fixtures/identity-fixtures';

interface StaffAccountBody {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
}

/** The `/users` HTTP contract: status codes and error envelopes (§5.2, §9.1). */
describe('User endpoints (e2e)', () => {
  let harness: IdentityHarness;
  let adminToken: string;

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;
  const accountOf = (res: { body: unknown }): StaffAccountBody =>
    res.body as StaffAccountBody;

  const newAccount = (overrides: Record<string, unknown> = {}) => ({
    email: `created-${uuidv7()}@cafepos.test`,
    displayName: 'Fresh Barista',
    role: 'BARISTA',
    password: FIXTURE_PASSWORD,
    ...overrides,
  });

  const createUser = (body: Record<string, unknown>) =>
    harness
      .http()
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    adminToken = await harness.accessTokenFor('ADMIN');
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('POST /users', () => {
    it('creates an account and answers 201 without the hash', async () => {
      const res = await createUser(newAccount());

      expect(res.status).toBe(201);
      expect(accountOf(res)).toMatchObject({
        role: 'BARISTA',
        isActive: true,
      });
      expect(JSON.stringify(res.body)).not.toContain('argon2');
    });

    it('reports a taken email as 409 USER_EMAIL_EXISTS', async () => {
      const body = newAccount();
      await createUser(body);

      const res = await createUser(body);

      expect(res.status).toBe(409);
      expect(problemOf(res).code).toBe('USER_EMAIL_EXISTS');
      expect(problemOf(res).meta).toEqual({ email: body.email });
    });

    // §6.1: minimum 10 characters, and nothing beyond that.
    it('rejects a password under the minimum length', async () => {
      const res = await createUser(newAccount({ password: 'short' }));

      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0].field).toBe('password');
    });

    it('rejects a role outside the enum', async () => {
      const res = await createUser(newAccount({ role: 'SUPERUSER' }));

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /users', () => {
    it('lists accounts without their hashes', async () => {
      const res = await harness
        .http()
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    });
  });

  describe('PATCH /users/:id', () => {
    it('updates a mutable field', async () => {
      const created = await createUser(newAccount());

      const res = await harness
        .http()
        .patch(`/api/v1/users/${accountOf(created).id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ displayName: 'Promoted Barista', role: 'CASHIER' });

      expect(res.status).toBe(200);
      expect(accountOf(res)).toMatchObject({
        displayName: 'Promoted Barista',
        role: 'CASHIER',
      });
    });

    // §8: an empty PATCH is a client bug; a 200 would hide it.
    it('rejects a body with no mutable field', async () => {
      const created = await createUser(newAccount());

      const res = await harness
        .http()
        .patch(`/api/v1/users/${accountOf(created).id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(422);
    });

    // Proves the UUIDv7 ids this project mints satisfy the param schema.
    it('answers 404 for a well-formed id nobody holds', async () => {
      const res = await harness
        .http()
        .patch(`/api/v1/users/${uuidv7()}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ displayName: 'Nobody' });

      expect(res.status).toBe(404);
      expect(problemOf(res).code).toBe('RESOURCE_NOT_FOUND');
    });

    it('rejects an id that is not a UUID with the validation envelope', async () => {
      const res = await harness
        .http()
        .patch('/api/v1/users/not-a-uuid')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ displayName: 'Nobody' });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('VALIDATION_FAILED');
    });
  });
});
