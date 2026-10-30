import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';
import { RateLimitedError } from './rate-limited.error';

describe('RateLimitedError', () => {
  it('carries the §9.2 code and status', () => {
    const error = new RateLimitedError(42);

    expect(error).toBeInstanceOf(AppException);
    expect(error.code).toBe(ErrorCode.RATE_LIMITED);
    expect(error.status).toBe(429);
  });

  // §9.1 names retryAfterSeconds as the meta a 429 carries.
  it('tells the client how long to wait', () => {
    expect(new RateLimitedError(42).meta).toEqual({ retryAfterSeconds: 42 });
  });

  it('never reports a wait shorter than a second', () => {
    expect(new RateLimitedError(0).meta).toEqual({ retryAfterSeconds: 1 });
  });
});
