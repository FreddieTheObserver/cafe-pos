import type Redis from 'ioredis';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import { AccessTokenService } from '../src/identity/auth/access-token.service';
import { deadRedisClient } from './fixtures/dead-redis';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * What the whole application does when Redis is gone.
 *
 * `menu-cache-degraded` already pins the cache's fail-open behaviour, and it
 * passed throughout the outage that made every authenticated route answer 500:
 * it constructs `MenuCacheService` by hand and never issues a request, so the
 * global throttler — which runs before every handler and had no error handling
 * — was never in the picture. A claim about what a *request* does can only be
 * pinned by making one.
 *
 * The split this file exists to hold in place, per §10.2 and the 503 row of
 * §9.2's table:
 *
 *   - The 600/min staff backstop is a backstop. Losing it to an outage costs
 *     nothing that matters, and refusing traffic instead would close the cafe.
 *     It fails open.
 *   - The login and pairing-code limits *are* the brute-force defence. Serving
 *     those routes with no counter is worse than not serving them, so they
 *     fail closed — deliberately, and with the 503 the design names for a
 *     dependency being down rather than an unexplained 500.
 */
describe('The API with Redis unreachable (e2e)', () => {
  let harness: IdentityHarness;
  let redis: Redis;
  let staffToken: string;
  let deviceToken: string;

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;

  beforeAll(async () => {
    redis = deadRedisClient();
    harness = await IdentityHarness.boot({ redis });

    // Both credentials are minted without Redis on purpose: logging in is one
    // of the things an outage refuses, so a token that came from `/auth/login`
    // could not exist here. The device token is a database row, and the staff
    // token is signed by the same service the login route uses.
    const manager = await harness.createStaff('MANAGER');
    staffToken = (
      await harness.app
        .get(AccessTokenService)
        .issue({ id: manager.id, role: 'MANAGER' })
    ).accessToken;
    deviceToken = (await harness.createDevice()).token;
  });

  afterAll(async () => {
    await harness.close();
    redis.disconnect();
  });

  describe('routes the backstop protects', () => {
    it('still serves a kiosk its menu', async () => {
      const res = await harness
        .http()
        .get('/api/v1/menu')
        .set('Authorization', `Bearer ${deviceToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('categories');
    });

    /**
     * A kiosk polling every 10 seconds is holding `W/"catalog-N"` when the
     * outage starts. With no counter to compare against, the one answer that
     * cannot be given is 304 — that would pin the kiosk to whatever it had
     * when Redis went down, for as long as the outage lasts.
     */
    it('does not answer a pre-outage validator with a 304', async () => {
      const res = await harness
        .http()
        .get('/api/v1/menu')
        .set('Authorization', `Bearer ${deviceToken}`)
        .set('If-None-Match', 'W/"catalog-1"');

      expect(res.status).toBe(200);
      // Express supplies a content-hash validator of its own here, but no
      // validator at all is equally correct — and `toMatch` is a matcher error
      // rather than a pass on `undefined`, which would report the stronger
      // outcome as a failure.
      expect(res.headers.etag ?? '').not.toMatch(/catalog-/);
    });

    /**
     * The outage that prompted this file took down every authenticated route,
     * not only the cached one — which is what identified the throttler rather
     * than the menu cache as the cause. A route that never touches Redis must
     * not notice that Redis is missing.
     */
    it('serves a staff read that has nothing to do with Redis', async () => {
      const res = await harness
        .http()
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${staffToken}`);

      expect(res.status).toBe(200);
    });
  });

  describe('routes whose rate limit is the security control', () => {
    it('refuses to sign anyone in rather than sign them in uncounted', async () => {
      const res = await harness
        .http()
        .post('/api/v1/auth/login')
        .send({ email: 'someone@cafepos.test', password: 'whatever' });

      expect(res.status).toBe(503);
      expect(problemOf(res).code).toBe('DEPENDENCY_UNAVAILABLE');
    });

    it('refuses to accept a pairing code it cannot count guesses against', async () => {
      const res = await harness
        .http()
        .post('/api/v1/devices/activate')
        .send({ pairingCode: 'ZZZZ9999' });

      expect(res.status).toBe(503);
      expect(problemOf(res).code).toBe('DEPENDENCY_UNAVAILABLE');
    });
  });

  describe('the probes an orchestrator reads', () => {
    it('stays alive, because the process is fine', async () => {
      expect((await harness.http().get('/healthz')).status).toBe(200);
    });

    it('reports itself unready, because a dependency is not', async () => {
      const res = await harness.http().get('/readyz');

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        status: 'unavailable',
        checks: { db: { status: 'up' }, redis: { status: 'down' } },
      });
    });
  });

  /**
   * A pod told to stop during an outage still has to stop. `quit()` on a client
   * that has already given up rejects with "Connection is closed", and an
   * `onApplicationShutdown` that rejects turns an ordinary rollout into a
   * shutdown error in the logs — and a container the orchestrator has to kill.
   */
  it('shuts down cleanly with the client already dead', async () => {
    const spare = await IdentityHarness.boot({ redis: deadRedisClient() });
    // Drives the client to its 'end' state; a client that never sent a command
    // is still 'wait', where `quit()` short-circuits and proves nothing.
    await spare.http().get('/readyz');

    await expect(spare.close()).resolves.toBeUndefined();
  });
});
