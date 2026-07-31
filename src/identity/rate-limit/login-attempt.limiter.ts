import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { RateLimitedError } from '../../common/errors/rate-limited.error';
import { REDIS } from '../../redis/redis.constants';

/** §6.1: 5 failures / 15 min per account, then a temporary lockout. */
const MAX_FAILURES = 5;
const WINDOW_SECONDS = 15 * 60;

/**
 * Reads the failure count and the remaining window as one fact.
 *
 * KEYS[1] counter key. Returns: count, TTL in seconds (-1 no expiry, -2 no key).
 */
const READ_LOCKOUT_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
return { count, redis.call('TTL', KEYS[1]) }
`;

/**
 * Increments the failure count, setting the window on the first failure only.
 *
 * KEYS[1] counter key · ARGV[1] window in seconds.
 */
const RECORD_FAILURE_SCRIPT = `
local failures = redis.call('INCR', KEYS[1])
if failures == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return failures
`;

/**
 * Per-account login lockout (§6.1, §10.2).
 *
 * Separate from the throttler because it counts *failures*, not requests: a
 * cashier signing in correctly forty times in a morning must not be locked
 * out, while five wrong passwords must lock the account regardless of how many
 * addresses they came from. The throttler's per-IP rule is the other half —
 * one stops a distributed attack on one account, the other stops one host
 * working through many accounts.
 *
 * State lives in Redis so the count is shared across instances; an in-process
 * counter would hand an attacker five attempts per pod.
 */
@Injectable()
export class LoginAttemptLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Keyed case-insensitively because `users.email` is CITEXT (§7.2) — a
   * lockout that "ADMIN@cafe.test" walks around by sending "admin@cafe.test"
   * is not a lockout.
   */
  private keyFor(email: string): string {
    return `login-failures:${email.trim().toLowerCase()}`;
  }

  /**
   * Throws if this account is currently locked out. Call before checking the
   * password.
   *
   * The count and the remaining window are read in one script so they describe
   * the same instant. Read separately, the key can expire between them: the
   * count still says "locked", the TTL says "no such key", and the naive
   * reading of that is a *fresh* full-length lockout for someone whose window
   * had just ended.
   */
  async assertNotLockedOut(email: string): Promise<void> {
    const key = this.keyFor(email);
    const [failures, ttl] = (await this.redis.eval(
      READ_LOCKOUT_SCRIPT,
      1,
      key,
    )) as [number, number];

    if (failures < MAX_FAILURES) return;

    // A counter at the limit with no expiry (-1) would be a lockout nothing
    // can end — no request clears it and Redis never drops it. `recordFailure`
    // makes that unreachable, but repairing it here means a stray key from an
    // older build, or a hand-edited one, still ages out.
    if (ttl < 0) {
      await this.redis.expire(key, WINDOW_SECONDS);
      throw new RateLimitedError(WINDOW_SECONDS);
    }

    throw new RateLimitedError(ttl);
  }

  /**
   * Records one failed attempt.
   *
   * Increment and expiry are one script because they have to be one fact. Sent
   * as two commands, a process that dies in between leaves a counter with no
   * expiry — and since only a successful login clears it, that account is
   * locked out permanently.
   *
   * The expiry is set only on the first failure, so the window runs from the
   * first bad attempt rather than sliding forward with each one — otherwise a
   * slow trickle of guesses would keep an account locked indefinitely.
   */
  async recordFailure(email: string): Promise<void> {
    await this.redis.eval(
      RECORD_FAILURE_SCRIPT,
      1,
      this.keyFor(email),
      WINDOW_SECONDS,
    );
  }

  /** Clears the count after a successful sign-in. */
  async clear(email: string): Promise<void> {
    await this.redis.del(this.keyFor(email));
  }
}
