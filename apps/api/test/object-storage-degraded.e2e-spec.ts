import { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.validation';
import { ObjectStorageService } from '../src/storage/object-storage.service';

/**
 * The fail-fast claim in `ObjectStorageService.onModuleInit`, against object
 * storage that is genuinely not there.
 *
 * The contrast with `MenuCacheService` is the point. Redis is a cache, so it
 * fails open — a slow menu beats no menu. Object storage is where item photos
 * live, and a process that boots happily without it has moved a config error
 * from deploy time (a rollback) to business hours (a manager standing at a
 * screen that will not take a photo). Same dependency style, opposite policy,
 * and both deserve a test saying so on purpose.
 */
describe('ObjectStorageService with the bucket unreachable (e2e)', () => {
  let s3: S3Client;

  /**
   * Only the three keys this service reads. Cast because `ConfigService`'s
   * `infer` overload wants the full `Env`, and standing up every unrelated
   * variable would say nothing about what is under test.
   */
  const config = (overrides: Record<string, unknown> = {}) =>
    new ConfigService({
      S3_BUCKET: 'cafepos-media',
      S3_PUBLIC_BASE_URL: 'http://localhost:9399/cafepos-media',
      S3_AUTO_CREATE_BUCKET: false,
      ...overrides,
    }) as unknown as ConfigService<Env, true>;

  beforeAll(() => {
    s3 = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'unused', secretAccessKey: 'unused' },
      // Nothing listens here.
      endpoint: 'http://127.0.0.1:9399',
      forcePathStyle: true,
      maxAttempts: 1,
    });
  });

  afterAll(() => {
    s3.destroy();
  });

  it('refuses to boot rather than failing on the first upload', async () => {
    const storage = new ObjectStorageService(s3, config());

    await expect(storage.onModuleInit()).rejects.toThrow(/not reachable/);
  });

  /**
   * The message has to say what to do about it. A boot failure reading only
   * "connect ECONNREFUSED" sends whoever is on call reading source at the
   * worst possible moment.
   */
  it('names the bucket and the knobs worth checking', async () => {
    const storage = new ObjectStorageService(s3, config());

    await expect(storage.onModuleInit()).rejects.toThrow(
      /cafepos-media[\s\S]*S3_ENDPOINT[\s\S]*S3_AUTO_CREATE_BUCKET/,
    );
  });

  // With auto-create on, an unreachable endpoint still fails — it just fails
  // on the create instead of the head. What it must never do is succeed.
  it('still fails when auto-create cannot reach the endpoint either', async () => {
    const storage = new ObjectStorageService(
      s3,
      config({ S3_AUTO_CREATE_BUCKET: true }),
    );

    await expect(storage.onModuleInit()).rejects.toThrow();
  });
});
