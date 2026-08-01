import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import type { Env } from '../config/env.validation';
import { ObjectStorageService } from './object-storage.service';
import { S3_CLIENT } from './storage.constants';

/**
 * The S3-compatible object store (§12.4).
 *
 * `@Global` for the same reason as `DatabaseModule` and `RedisModule`: it is
 * infrastructure several feature modules will reach for, and threading an
 * import through each of them buys nothing.
 */
@Global()
@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const endpoint = config.get('S3_ENDPOINT', { infer: true });

        return new S3Client({
          region: config.get('S3_REGION', { infer: true }),
          credentials: {
            accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
            secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', {
              infer: true,
            }),
          },
          // Unset against real AWS, where the SDK resolves the regional
          // endpoint itself.
          ...(endpoint === undefined ? {} : { endpoint }),
          // MinIO serves one host, not per-bucket subdomains, so addressing
          // has to be `host/bucket/key`. Harmless against AWS, which still
          // honours path style.
          forcePathStyle: endpoint !== undefined,
        });
      },
    },
    ObjectStorageService,
  ],
  exports: [ObjectStorageService],
})
export class StorageModule implements OnApplicationShutdown {
  constructor(@Inject(S3_CLIENT) private readonly s3: S3Client) {}

  onApplicationShutdown(): void {
    // Releases the SDK's keep-alive sockets so a SIGTERM during a rolling
    // deploy does not wait on them (§16).
    this.s3.destroy();
  }
}
