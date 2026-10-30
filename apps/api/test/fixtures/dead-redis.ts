import Redis from 'ioredis';

/** Nothing listens here. That is the entire point of the fixture. */
const DEAD_PORT = 6399;

/**
 * A real ioredis client pointed at a closed port.
 *
 * A real client rather than a stub that throws `new Error('boom')`: ioredis
 * raises an `AggregateError` whose own `message` is empty, and a hand-written
 * fixture would not reproduce that shape. Phase 0 shipped three defects behind
 * exactly that mistake, all of them found by pointing the real code at a dead
 * dependency instead of imagining one.
 */
export function deadRedisClient(): Redis {
  const redis = new Redis({
    host: '127.0.0.1',
    port: DEAD_PORT,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    // Fail fast instead of reconnecting for the length of the test timeout.
    retryStrategy: () => null,
    // `disconnect()` arms a force-close timer of this length, and a socket that
    // never opened has no 'close' event left to clear it. At the 2s default the
    // timer outlives the suite, and Jest reports a leaked handle — which reads
    // like a hang rather than a passing test.
    disconnectTimeout: 50,
  });

  // ioredis emits 'error' on every failed attempt, and an EventEmitter with no
  // error listener takes the process down with it.
  redis.on('error', () => undefined);

  return redis;
}
