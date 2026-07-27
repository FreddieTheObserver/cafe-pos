import type { LoggerService } from '@nestjs/common';
import { describeError } from '../common/errors/describe-error';

/**
 * How long the client stays quiet after logging a connection error.
 *
 * ioredis retries several times a second while Redis is unreachable and emits an
 * `error` per attempt — an unthrottled listener produced ~57 lines in 9 seconds.
 * At 30s an operator still sees the outage open, close, and stay open in the
 * logs, while a night-long outage across 2 instances costs ~5 lines/min rather
 * than thousands: `error` must stay a level a human reads (§13).
 */
export const REDIS_ERROR_LOG_INTERVAL_MS = 30_000;

/** The slice of the ioredis client these diagnostics touch (an EventEmitter). */
export interface RedisEventSource {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
}

/** Only the levels emitted below, so callers can pass a plain Nest `Logger`. */
type DiagnosticsLogger = Pick<LoggerService, 'log' | 'error'>;

/**
 * Routes ioredis connection failures into structured logging (§13).
 *
 * Without an `error` listener ioredis prints its own multi-line dump straight to
 * stderr, bypassing pino: unparseable by the log pipeline, and impossible to
 * alert on. Errors are throttled (see the interval above) and the reconnect is
 * logged too, so an operator can see the outage close rather than inferring it
 * from silence.
 */
export function attachRedisDiagnostics(
  client: RedisEventSource,
  logger: DiagnosticsLogger,
): void {
  // Null while healthy; the timestamp of the outage's first error otherwise.
  let outageStartedAt: number | null = null;
  let lastLoggedAt = 0;
  let errorsInOutage = 0;
  let suppressedSinceLastLog = 0;

  client.on('error', (err: Error) => {
    const now = Date.now();
    errorsInOutage += 1;

    if (outageStartedAt === null) {
      outageStartedAt = now;
      lastLoggedAt = now;
      logger.error(
        `Redis connection error: ${describeError(err)} — further errors logged at most once per ${REDIS_ERROR_LOG_INTERVAL_MS / 1000}s`,
      );
      return;
    }

    if (now - lastLoggedAt < REDIS_ERROR_LOG_INTERVAL_MS) {
      suppressedSinceLastLog += 1;
      return;
    }

    logger.error(
      `Redis connection error: ${describeError(err)} (suppressed since the last log: ${suppressedSinceLastLog})`,
    );
    lastLoggedAt = now;
    suppressedSinceLastLog = 0;
  });

  client.on('ready', () => {
    // `ready` also fires on a healthy first connect, which is not news.
    if (outageStartedAt === null) return;

    const downForSeconds = Math.round((Date.now() - outageStartedAt) / 1000);
    logger.log(
      `Redis connection recovered after ${downForSeconds}s (errors during the outage: ${errorsInOutage})`,
    );
    outageStartedAt = null;
    errorsInOutage = 0;
    suppressedSinceLastLog = 0;
  });
}
