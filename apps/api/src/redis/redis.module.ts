import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Env } from '../config/env.validation';
import { closeRedis } from './close-redis';
import { REDIS } from './redis.constants';
import { attachRedisDiagnostics } from './redis.diagnostics';

/**
 * Provides the shared Redis client (cache, pub/sub, rate limits, queues — §12.1).
 * `maxRetriesPerRequest: 1` keeps calls (e.g. the readiness ping) from hanging
 * on a long retry loop when Redis is down.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const client = new Redis(config.get('REDIS_URL', { infer: true }), {
          maxRetriesPerRequest: 1,
          lazyConnect: false,
        });
        // Attached before the first connect attempt: ioredis dumps unhandled
        // connection errors to raw stderr otherwise, outside pino (§13).
        attachRedisDiagnostics(client, new Logger('Redis'));
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    /**
     * The `catch`-and-disconnect this used to do covered a client that had
     * *given up*, but not one still *reconnecting* — the default policy when
     * Redis is merely down. That one queues the QUIT and waits for a connection
     * that may never arrive, so a rollout during an outage would hang here.
     * `closeRedis` checks `status` first, which distinguishes the two.
     */
    await closeRedis(this.redis);
  }
}
