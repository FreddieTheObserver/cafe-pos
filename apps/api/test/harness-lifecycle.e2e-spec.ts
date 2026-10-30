import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import {
  FIXTURE_PASSWORD,
  IdentityHarness,
} from './fixtures/identity-fixtures';

/**
 * Guards the e2e harness against a footgun that cost a CI run.
 *
 * supertest's `serverAddress()` calls `app.listen(0)` when it is handed a
 * server that is not listening — and the `Test` that did so then *closes* that
 * shared server as soon as its own request finishes. For sequential requests
 * that is invisible. For a `Promise.all` burst it means the first request to
 * complete shuts the server down underneath its siblings, and whichever of them
 * had not finished connecting yet dies with ECONNRESET.
 *
 * It is timing-dependent, so it passes on a fast laptop and fails on a loaded
 * CI runner. Asserting the *invariant* — the harness owns the server and it
 * stays up — is deterministic, which asserting the symptom is not.
 */
describe('IdentityHarness HTTP lifecycle (e2e)', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
  });

  afterAll(async () => {
    await harness.close();
  });

  const isListening = () =>
    (harness.app.getHttpServer() as { listening: boolean }).listening;

  it('is already listening before any request is made', () => {
    expect(isListening()).toBe(true);
  });

  it('is still listening after a sequential request', async () => {
    await harness.http().get('/healthz');

    expect(isListening()).toBe(true);
  });

  it('survives a concurrent burst with the server still up', async () => {
    const statuses = await Promise.all(
      Array.from({ length: 40 }, () =>
        harness
          .http()
          .get('/healthz')
          .then((res) => res.status),
      ),
    );

    expect(statuses.every((status) => status === 200)).toBe(true);
    // The assertion that actually catches the bug: supertest must never have
    // taken ownership of the server, so nothing can close it mid-suite.
    expect(isListening()).toBe(true);
  });

  it('is still usable after the burst', async () => {
    const res = await harness.http().get('/healthz');

    expect(res.status).toBe(200);
  });

  /**
   * The other half of "a suite cleans up after itself": rows a test creates by
   * calling the API, which the harness never sees and so cannot know about.
   *
   * `createStaff` inserts directly and is tracked; `POST /users` is not, and
   * `users-http` leaked four accounts on every single run — twenty-four of them
   * had accumulated in the development database before anyone looked. Devices
   * already had `trackDevice` for exactly this; users had no equivalent.
   */
  it('removes a user created through the API once it is tracked', async () => {
    const spare = await IdentityHarness.boot();
    const adminToken = await spare.accessTokenFor('ADMIN');
    const email = `lifecycle-${uuidv7()}@cafepos.test`;

    const created = await spare
      .http()
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email,
        displayName: 'Lifecycle Check',
        role: 'BARISTA',
        password: FIXTURE_PASSWORD,
      });
    expect(created.status).toBe(201);
    spare.trackUser((created.body as { id: string }).id);

    await spare.close();

    // Read through a different harness: the one that made the row is gone.
    const survivors = await harness.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    expect(survivors).toEqual([]);
  });
});
