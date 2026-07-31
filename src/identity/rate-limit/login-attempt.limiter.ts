import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { RateLimitedError } from '../../common/errors/rate-limited.error';
import { REDIS } from '../../redis/redis.constants';

/** §6.1: 5 failures / 15 min per account, then a temporary lockout. */
const MAX_FAILURES = 5;
const WINDOW_SECONDS = 15 * 60;

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

  /** Throws if this account is currently locked out. Call before checking the password. */
  async assertNotLockedOut(email: string): Promise<void> {
    const key = this.keyFor(email);
    const failures = Number((await this.redis.get(key)) ?? 0);
    if (failures < MAX_FAILURES) return;

    const ttl = await this.redis.ttl(key);
    throw new RateLimitedError(ttl > 0 ? ttl : WINDOW_SECONDS);
  }

  /**
   * Records one failed attempt.
   *
   * The expiry is set only on the first failure, so the window runs from the
   * first bad attempt rather than sliding forward with each one — otherwise a
   * slow trickle of guesses would keep an account locked indefinitely.
   */
  async recordFailure(email: string): Promise<void> {
    const key = this.keyFor(email);
    const failures = await this.redis.incr(key);
    if (failures === 1) await this.redis.expire(key, WINDOW_SECONDS);
  }

  /** Clears the count after a successful sign-in. */
  async clear(email: string): Promise<void> {
    await this.redis.del(this.keyFor(email));
  }
}
