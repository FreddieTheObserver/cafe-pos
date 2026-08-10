import { Logger, type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { describeError } from '../common/errors/describe-error';
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
    this.pub = base.duplicate();
    this.sub = base.duplicate();
    attachRedisDiagnostics(this.pub, new Logger('RealtimeRedisPub'));
    attachRedisDiagnostics(this.sub, new Logger('RealtimeRedisSub'));

    server.adapter(createAdapter(unattended(this.pub), unattended(this.sub)));

    /**
     * The Redis adapter reports a failed subscribe by emitting `error` on the
     * per-namespace adapter — and an `EventEmitter` that emits `error` with no
     * listener **throws**, taking the process down. That is how a Redis blip
     * became a crash rather than a degraded feed, and it is not something a
     * `try`/`catch` around `createAdapter` can reach, because the emit happens
     * later, from a callback.
     *
     * Namespaces are created lazily as gateways register, so the listener is
     * attached on creation rather than up front; `/` already exists by now and
     * is handled separately.
     */
    server
      .of('/')
      .adapter.on('error', (error: unknown) => this.degraded(error));
    server.on('new_namespace', (namespace) => {
      namespace.adapter.on('error', (error: unknown) => this.degraded(error));
    });

    this.logger.log('Socket.IO clustered over Redis pub/sub');

    return server;
  }

  /**
   * A broadcast that did not make it across instances. Logged, never thrown:
   * the screens reconcile from `GET /kds/orders` (§5.5), so a lost push costs a
   * board one refresh rather than costing the process its life.
   */
  private degraded(error: unknown): void {
    this.logger.warn(`Realtime pub/sub degraded: ${describeError(error)}`);
  }

  async close(server: Server): Promise<void> {
    await super.close(server);
    await this.dispose();
  }

  /**
   * Closes the pub/sub pair this adapter created, and nothing else — the base
   * client belongs to `RedisModule`'s shutdown hook.
   *
   * **`close()` is not enough, because Nest never calls it.** Measured, not
   * assumed: a harness boot that creates a server and then closes the
   * application invokes this class's `close` zero times. Every owner therefore
   * has to dispose explicitly, or two clients keep retrying for the life of the
   * process — which in a test runner means every booted app leaks a pair, and
   * the accumulated churn eventually starves the suites that come later.
   */
  async dispose(): Promise<void> {
    await Promise.allSettled([stop(this.pub), stop(this.sub)]);
    this.pub = undefined;
    this.sub = undefined;
  }
}

/**
 * A view of a client whose command promises are never left unattended.
 *
 * ioredis commands return promises, and `@socket.io/redis-adapter` issues
 * several without awaiting or catching them — `psubscribe` is called bare in
 * its constructor. Any rejection of those is therefore an *unhandled* rejection,
 * which Node turns into a process exit: a dead `REDIS_URL` crashed the API on
 * boot, and disconnecting the client at shutdown flushed the offline queue and
 * crashed it again on the way out.
 *
 * The adapter's `error` event cannot reach these, because they never travel
 * through a callback. Attaching a catch as the promise is handed back is the
 * only interception point that exists, and it discards nothing anyone was
 * reading: the failures the adapter genuinely reports go through the callbacks
 * that `createIOServer` listens to. What is lost is a broadcast, which §5.5
 * already makes recoverable — screens resync from `GET /kds/orders`.
 */
const unattended = (client: Redis): Redis =>
  new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;

      return (...args: unknown[]): unknown => {
        const result: unknown = (
          value as (this: Redis, ...a: unknown[]) => unknown
        ).apply(target, args);
        // The caller still receives the original promise; it simply is no
        // longer the only thing standing between a rejection and the process.
        if (result instanceof Promise) void result.catch(() => undefined);
        return result;
      };
    },
  });

/**
 * `quit` drains in flight replies and is the right call normally; a client that
 * never reached a server rejects it outright, so fall back to closing the
 * socket. Same reasoning, and same shape, as `RedisModule`'s shutdown hook.
 */
const stop = async (client?: Redis): Promise<void> => {
  if (!client) return;

  /**
   * A client that never reached a server has nothing to drain, and `quit` on it
   * queues a QUIT behind a connection that is still being retried — so shutdown
   * would wait on exactly the outage the retry policy exists to survive. Close
   * the socket instead.
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
