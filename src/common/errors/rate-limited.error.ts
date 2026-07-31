import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';

/**
 * Too many requests (§9.2, §10.2).
 *
 * `retryAfterSeconds` is in `meta` because §9.1 says so, and it mirrors the
 * `Retry-After` header: a kiosk showing "try again in a moment" reads JSON,
 * not response headers, and should not have to parse both.
 */
export class RateLimitedError extends AppException {
  constructor(retryAfterSeconds: number) {
    super({
      code: ErrorCode.RATE_LIMITED,
      status: 429,
      title: 'Too many requests',
      detail: 'Too many requests. Try again shortly.',
      // Never zero: "retry after 0 seconds" invites an immediate retry, which
      // is precisely the behaviour the limit exists to stop.
      meta: { retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) },
    });
  }
}
