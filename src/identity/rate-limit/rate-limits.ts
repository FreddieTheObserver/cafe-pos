import { Throttle } from '@nestjs/throttler';

const minutes = (n: number) => n * 60_000;
const hours = (n: number) => minutes(60 * n);

/**
 * The §10.2 table, in one place.
 *
 * A single throttler is configured globally and overridden per route, rather
 * than three named throttlers every controller then has to opt out of. With
 * named throttlers each rule applies everywhere until skipped, so forgetting a
 * `@SkipThrottle` silently caps an unrelated endpoint at 5/hour — the failure
 * is invisible until a real user hits it.
 */
export const RATE_LIMITS = {
  /**
   * "Staff API general: 600/min per user — backstop, not a constraint."
   * Applied to every route that does not override it.
   */
  staffGeneral: { limit: 600, ttl: minutes(1), blockDuration: minutes(1) },

  /**
   * Credential stuffing (§10.2). This is the per-*address* half; the
   * per-account half counts failures and lives in `LoginAttemptLimiter`.
   */
  login: { limit: 20, ttl: minutes(15), blockDuration: minutes(15) },

  /**
   * Pairing-code guessing. 8 characters over a 31-symbol alphabet with a
   * 10-minute TTL is already infeasible to brute force; §10.2's own words are
   * that this limit "makes it silly".
   */
  deviceActivation: { limit: 5, ttl: hours(1), blockDuration: hours(1) },
} as const;

/** Overrides the global limit for one route (§10.2). */
export const RateLimit = (rule: {
  limit: number;
  ttl: number;
  blockDuration: number;
}) => Throttle({ default: rule });
