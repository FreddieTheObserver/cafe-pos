import Redis from 'ioredis';
import { uuidv7 } from 'uuidv7';
import { RateLimitedError } from '../src/common/errors/rate-limited.error';
import { LoginAttemptLimiter } from '../src/identity/rate-limit/login-attempt.limiter';

/**
 * §6.1/§10.2: 5 failures per 15 minutes *per account*. This counts failures,
 * not requests, so it cannot be a throttler rule — and it has to be shared
 * across instances, or an attacker gets five tries per pod.
 */
describe('LoginAttemptLimiter (integration)', () => {
  let redis: Redis;
  let limiter: LoginAttemptLimiter;

  const FAILURES_ALLOWED = 5;
  const freshEmail = () => `lockout-${uuidv7()}@cafepos.test`;

  const failTimes = async (email: string, times: number) => {
    for (let i = 0; i < times; i += 1) await limiter.recordFailure(email);
  };

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    limiter = new LoginAttemptLimiter(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('lets an untouched account through', async () => {
    await expect(
      limiter.assertNotLockedOut(freshEmail()),
    ).resolves.toBeUndefined();
  });

  it('still allows the attempt that reaches the last permitted failure', async () => {
    const email = freshEmail();
    await failTimes(email, FAILURES_ALLOWED - 1);

    await expect(limiter.assertNotLockedOut(email)).resolves.toBeUndefined();
  });

  it('locks the account out once the failures run out', async () => {
    const email = freshEmail();
    await failTimes(email, FAILURES_ALLOWED);

    await expect(limiter.assertNotLockedOut(email)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('tells the caller how long the lockout lasts', async () => {
    const email = freshEmail();
    await failTimes(email, FAILURES_ALLOWED);

    const caught: unknown = await limiter
      .assertNotLockedOut(email)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(RateLimitedError);
    const retryAfter = (
      (caught as RateLimitedError).meta as { retryAfterSeconds: number }
    ).retryAfterSeconds;
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  });

  // Otherwise one person fat-fingering their password five times would lock
  // out the whole cafe by locking every account at once.
  it('counts each account separately', async () => {
    const locked = freshEmail();
    await failTimes(locked, FAILURES_ALLOWED);

    await expect(
      limiter.assertNotLockedOut(freshEmail()),
    ).resolves.toBeUndefined();
  });

  it('forgets the failures after a successful sign-in', async () => {
    const email = freshEmail();
    await failTimes(email, FAILURES_ALLOWED);

    await limiter.clear(email);

    await expect(limiter.assertNotLockedOut(email)).resolves.toBeUndefined();
  });

  // users.email is CITEXT (§7.2); a lockout that misses "ADMIN@..." because it
  // was stored as "admin@..." is not a lockout.
  it('treats the account case-insensitively, as the email column does', async () => {
    const email = freshEmail();
    await failTimes(email.toUpperCase(), FAILURES_ALLOWED);

    await expect(limiter.assertNotLockedOut(email)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });
});
