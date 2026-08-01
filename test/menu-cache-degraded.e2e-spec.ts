import Redis from 'ioredis';
import { MenuCacheService } from '../src/catalog/menu/menu-cache.service';

/**
 * The fail-open claim in `MenuCacheService`, exercised against a Redis that is
 * genuinely not there.
 *
 * A real client against a closed port rather than a stub that throws
 * `new Error('boom')`: ioredis raises an `AggregateError` whose own `message`
 * is empty, and a hand-written fixture would not reproduce that shape. Phase 0
 * shipped three defects behind exactly that mistake, all of them found by
 * pointing the real code at a dead dependency instead of imagining one.
 *
 * What this pins: Redis being down degrades `GET /menu` to an uncached read
 * from Postgres. It must never turn the menu into a 500 — that is a cafe whose
 * kiosks cannot show anything.
 */
describe('MenuCacheService with Redis unreachable (e2e)', () => {
  let redis: Redis;
  let cache: MenuCacheService;

  beforeAll(() => {
    redis = new Redis({
      host: '127.0.0.1',
      // Nothing listens here; the real client's real connection failure is the
      // point of the fixture.
      port: 6399,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      // Fail fast instead of reconnecting for the length of the test timeout.
      retryStrategy: () => null,
      // `disconnect()` arms a force-close timer of this length, and a socket
      // that never opened has no 'close' event left to clear it. At the 2s
      // default the timer outlives the suite, and Jest reports a leaked handle
      // — which reads like a hang rather than a passing test.
      disconnectTimeout: 50,
    });
    // ioredis emits 'error' on every failed attempt, and an EventEmitter with
    // no error listener takes the process down with it.
    redis.on('error', () => undefined);

    cache = new MenuCacheService(redis);
  });

  afterAll(() => {
    redis.disconnect();
  });

  it('reports no version rather than throwing', async () => {
    await expect(cache.currentVersion()).resolves.toBeNull();
  });

  it('reports a cache miss rather than throwing', async () => {
    await expect(cache.read('1')).resolves.toBeNull();
  });

  it('swallows a failed write', async () => {
    await expect(
      cache.write('1', '{"categories":[]}'),
    ).resolves.toBeUndefined();
  });

  it('swallows a failed invalidation', async () => {
    await expect(cache.bump()).resolves.toBeUndefined();
  });
});
