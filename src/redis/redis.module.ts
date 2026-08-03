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
    try {
      await this.redis.quit();
    } catch {
      // `quit()` drains in-flight replies, which is why it is the right call
      // normally — but a client that has already given up on an unreachable
      // server rejects it outright, and a shutdown hook that throws turns an
      // ordinary rollout into an error the orchestrator has to clean up after.
      // There is nothing left to drain in that state; close the socket.
      this.redis.disconnect();
    }
  }
}
