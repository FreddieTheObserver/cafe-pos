import { Logger, type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { REDIS } from '../redis/redis.constants';
import { attachRedisDiagnostics } from '../redis/redis.diagnostics';

/**
 * Socket.IO over Redis pub/sub, so §11.3's two instances behave as one.
 *
 * Without this, a barista connected to instance A never sees an event emitted
 * by instance B — and because a single-instance dev box cannot reproduce that,
 * the bug ships. The adapter is therefore wired in from the first slice rather
 * than added when scaling "becomes a concern".
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger('RealtimeAdapter');
  private pub?: Redis;
  private sub?: Redis;

  constructor(
    private readonly context: INestApplicationContext,
    private readonly corsOrigins: string[],
  ) {
    super(context);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      /**
       * The board is a public page on someone else's origin, so the WS server
       * needs the same allowlist the REST API got. Left undefined when nothing
       * is configured, which is what every test and local run does — the same
       * default that hid a CORS bug from CI in Phase 2, so the origins are
       * asserted in the e2e suite rather than trusted here.
       */
      ...(this.corsOrigins.length > 0
        ? { cors: { origin: this.corsOrigins, credentials: true } }
        : {}),
    }) as Server;

    /**
     * Duplicated rather than shared: a connection in subscriber mode cannot run
     * ordinary commands, so handing the app's client to the adapter would break
     * the cache and the rate limiter the moment it subscribes.
     */
    const base = this.context.get<Redis>(REDIS);
    this.pub = base.duplicate(PUBSUB_OPTIONS);
    this.sub = base.duplicate(PUBSUB_OPTIONS);
    attachRedisDiagnostics(this.pub, new Logger('RealtimeRedisPub'));
    attachRedisDiagnostics(this.sub, new Logger('RealtimeRedisSub'));

    server.adapter(createAdapter(this.pub, this.sub));
    this.logger.log('Socket.IO clustered over Redis pub/sub');

    return server;
  }

  async close(server: Server): Promise<void> {
    await super.close(server);
    // Own what this class created, and nothing else - the base client belongs
    // to RedisModule's shutdown hook.
    await Promise.allSettled([stop(this.pub), stop(this.sub)]);
  }
}

/**
 * The pub/sub pair keeps retrying, whatever the app client is configured to do.
 *
 * `createAdapter` subscribes internally, and there is no hook to catch that
 * promise. Against a client that has given up — `retryStrategy` returning null,
 * or a permanently bad `REDIS_URL` — the subscribe rejects with nobody
 * listening, and an unhandled rejection takes the whole process down. An API
 * that refuses to boot because Redis is unreachable is precisely the failure
 * every other consumer here is careful to avoid: the cafe should still be
 * taking orders.
 *
 * Queuing is also the semantically right answer for a broadcast. A KDS event
 * that waits for the connection to come back is useful; one that throws is not.
 */
const PUBSUB_OPTIONS = {
  retryStrategy: (attempt: number) => Math.min(attempt * 200, 5000),
  // Never reject a queued command for having waited too long — see above.
  maxRetriesPerRequest: null,
} as const;

/**
 * `quit` drains in flight replies and is the right call normally; a client that
 * never reached a server rejects it outright, so fall back to closing the
 * socket. Same reasoning, and same shape, as `RedisModule`'s shutdown hook.
 */
const stop = async (client?: Redis): Promise<void> => {
  if (!client) return;

  /**
   * A client that never reached a server has nothing to drain, and asking it to
   * `quit` would *queue* the QUIT — `maxRetriesPerRequest: null` above means
   * that queued command waits forever, so shutdown would hang on exactly the
   * outage the retry policy exists to survive. Close the socket instead.
   */
  if (client.status !== 'ready') {
    client.disconnect();
    return;
  }

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
};
