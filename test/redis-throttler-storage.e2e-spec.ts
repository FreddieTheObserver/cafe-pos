import Redis from 'ioredis';
import { uuidv7 } from 'uuidv7';
import {
  RedisThrottlerStorage,
  type ThrottleRecord,
} from '../src/identity/rate-limit/redis-throttler.storage';

const THROTTLER = 'test';

/**
 * §10.2 puts rate-limit state in Redis specifically so it is *shared across
 * instances* — an in-memory counter would give an attacker one budget per API
 * pod. That property, and the atomicity that makes concurrent hits count
 * exactly once, only exist against a real Redis.
 */
describe('RedisThrottlerStorage (integration)', () => {
  let redis: Redis;
  let storage: RedisThrottlerStorage;

  // @nestjs/throttler passes ttl and blockDuration in milliseconds and expects
  // timeToExpire back in seconds; getting that backwards is silent and awful.
  const TTL_MS = 60_000;
  const NO_BLOCK = 0;

  const freshKey = () => `spec:${uuidv7()}`;

  const hit = (
    key: string,
    limit: number,
    blockMs = NO_BLOCK,
  ): Promise<ThrottleRecord> =>
    storage.increment(key, TTL_MS, limit, blockMs, THROTTLER);

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    storage = new RedisThrottlerStorage(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('counts each hit against the key', async () => {
    const key = freshKey();

    const first = await hit(key, 5);
    const second = await hit(key, 5);

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
  });

  it('leaves a caller under the limit unblocked', async () => {
    const key = freshKey();

    const record = await hit(key, 2);

    expect(record.isBlocked).toBe(false);
    expect(record.timeToBlockExpire).toBe(0);
  });

  it('blocks the hit that goes past the limit', async () => {
    const key = freshKey();
    await hit(key, 2);
    await hit(key, 2);

    const third = await hit(key, 2);

    expect(third.totalHits).toBe(3);
    expect(third.isBlocked).toBe(true);
  });

  it('reports the window in seconds, not milliseconds', async () => {
    const key = freshKey();

    const record = await hit(key, 5);

    expect(record.timeToExpire).toBeGreaterThan(50);
    expect(record.timeToExpire).toBeLessThanOrEqual(60);
  });

  it('keeps separate keys on separate budgets', async () => {
    const [a, b] = [freshKey(), freshKey()];
    await hit(a, 5);
    await hit(a, 5);

    expect((await hit(b, 5)).totalHits).toBe(1);
  });

  it('forgets a key once its window has passed', async () => {
    const key = freshKey();
    await storage.increment(key, 150, 5, NO_BLOCK, THROTTLER);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(
      (await storage.increment(key, 150, 5, NO_BLOCK, THROTTLER)).totalHits,
    ).toBe(1);
  });

  /**
   * A block that outlives the counting window is what turns "5 per 15 minutes"
   * into the temporary lockout §6.1 asks for, rather than a limit that lifts
   * the moment the window rolls.
   */
  it('holds a block past the end of the counting window', async () => {
    const key = freshKey();
    const blockMs = 5 * TTL_MS;
    await storage.increment(key, TTL_MS, 1, blockMs, THROTTLER);

    const blocked = await storage.increment(key, TTL_MS, 1, blockMs, THROTTLER);

    expect(blocked.isBlocked).toBe(true);
    expect(blocked.timeToBlockExpire).toBeGreaterThan(TTL_MS / 1000);
  });

  it('counts concurrent hits exactly once each', async () => {
    const key = freshKey();

    const records = await Promise.all(
      Array.from({ length: 20 }, () => hit(key, 100)),
    );

    expect(new Set(records.map((r) => r.totalHits)).size).toBe(20);
  });
});
