import Redis from 'ioredis';
import { uuidv7 } from 'uuidv7';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * The §10.2 limits as a caller experiences them: the status, the stable code,
 * the `Retry-After` header, and — the part that only shows over HTTP — which
 * bucket a given route actually draws from.
 */
describe('Rate limiting (e2e)', () => {
  let harness: IdentityHarness;
  let redis: Redis;

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;

  /**
   * Throttle keys are per-address here, and every test in this file shares one
   * address. Clearing between cases keeps each one stating its own premise
   * instead of inheriting the previous one's exhausted budget.
   */
  const clearThrottleState = async () => {
    const keys = await redis.keys('throttle:*');
    if (keys.length > 0) await redis.del(...keys);
  };

  const attemptLogin = (email: string) =>
    harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email, password: 'whatever-it-is-wrong' });

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  });

  afterAll(async () => {
    await redis.quit();
    await harness.close();
  });

  beforeEach(clearThrottleState);

  describe('POST /auth/login', () => {
    // §10.2: 20 per 15 minutes per IP.
    it('cuts the caller off past the per-address budget', async () => {
      let lastStatus = 0;
      for (let attempt = 0; attempt < 21; attempt += 1) {
        // A different account each time, so this is the *address* limit biting
        // rather than the per-account lockout.
        lastStatus = (await attemptLogin(`stuffing-${uuidv7()}@cafepos.test`))
          .status;
      }

      expect(lastStatus).toBe(429);
    });

    it('answers with the §9.1 envelope and a Retry-After header', async () => {
      let res = await attemptLogin(`stuffing-${uuidv7()}@cafepos.test`);
      for (let attempt = 0; attempt < 21 && res.status !== 429; attempt += 1) {
        res = await attemptLogin(`stuffing-${uuidv7()}@cafepos.test`);
      }

      expect(res.status).toBe(429);
      expect(problemOf(res).code).toBe('RATE_LIMITED');
      expect(problemOf(res).meta).toMatchObject({
        retryAfterSeconds: expect.any(Number) as number,
      });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });
  });

  describe('POST /devices/activate', () => {
    // §10.2: 5 per hour per IP — a much tighter budget than login's.
    it('runs out far sooner than the login budget does', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push(
          (
            await harness
              .http()
              .post('/api/v1/devices/activate')
              .send({ pairingCode: 'ZZZZ9999' })
          ).status,
        );
      }

      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses[5]).toBe(429);
    });
  });

  describe('the staff backstop', () => {
    /**
     * 600/min is deliberately not a constraint (§10.2). If ordinary use tripped
     * it, the limit would be a bug rather than a backstop — and the login
     * budget must not be the one being spent here.
     */
    it('does not interfere with normal authenticated traffic', async () => {
      const token = await harness.accessTokenFor('MANAGER');

      const statuses = await Promise.all(
        Array.from({ length: 30 }, () =>
          harness
            .http()
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${token}`)
            .then((res) => res.status),
        ),
      );

      expect(statuses.every((status) => status === 200)).toBe(true);
    });
  });

  describe('health probes', () => {
    it('are never rate limited, however hard the orchestrator polls', async () => {
      const statuses = await Promise.all(
        Array.from({ length: 40 }, () =>
          harness
            .http()
            .get('/healthz')
            .then((res) => res.status),
        ),
      );

      expect(statuses.every((status) => status === 200)).toBe(true);
    });
  });
});
