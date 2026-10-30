import type Redis from 'ioredis';
import { MenuCacheService } from '../src/catalog/menu/menu-cache.service';
import { deadRedisClient } from './fixtures/dead-redis';

/**
 * The fail-open claim in `MenuCacheService`, exercised against a Redis that is
 * genuinely not there.
 *
 * This is the unit of that claim, not the whole of it. That `GET /menu` really
 * does keep answering during an outage is a property of the request pipeline,
 * not of this class, and it is pinned over HTTP in `redis-outage-http` — where
 * it was found to be false while every assertion here passed.
 */
describe('MenuCacheService with Redis unreachable (e2e)', () => {
  let redis: Redis;
  let cache: MenuCacheService;

  beforeAll(() => {
    redis = deadRedisClient();
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
