import { SetMetadata, applyDecorators } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

const minutes = (n: number) => n * 60_000;
const hours = (n: number) => minutes(60 * n);

/**
 * What to do with a request when the rate-limit backend cannot be reached.
 *
 * There is no answer that is right for every route, which is why this is a
 * property of each rule rather than a policy inside the storage. `allow` keeps
 * serving and accepts that the limit is not being counted; `refuse` answers
 * 503 rather than serve a route whose protection has gone.
 */
export type BackendFailurePolicy = 'allow' | 'refuse';

/** Reflector key carrying a route's {@link BackendFailurePolicy}. */
export const RATE_LIMIT_BACKEND_POLICY = 'rate-limit:backend-failure';

export interface RateLimitRule {
  limit: number;
  ttl: number;
  blockDuration: number;
  onBackendFailure: BackendFailurePolicy;
}

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
   *
   * Fails open, because a backstop nobody is near is worth nothing next to the
   * cost of refusing: §11.2 requires the API to survive Redis, and a cafe whose
   * kiosks cannot show a menu is closed. Losing this limit during an outage
   * costs an abuse budget that ordinary traffic never approaches anyway.
   */
  staffGeneral: {
    limit: 600,
    ttl: minutes(1),
    blockDuration: minutes(1),
    onBackendFailure: 'allow',
  },

  /**
   * Credential stuffing (§10.2). This is the per-*address* half; the
   * per-account half counts failures and lives in `LoginAttemptLimiter`.
   *
   * Fails closed, because here the limit is not a backstop — it is the
   * defence. Serving this route with nothing counting would turn a Redis
   * outage into an unlimited guessing window against every account in the
   * cafe, which is a worse outcome than staff having to wait for Redis before
   * they can sign in. Anyone already signed in keeps working: access tokens
   * are verified against a signature, not against Redis.
   */
  login: {
    limit: 20,
    ttl: minutes(15),
    blockDuration: minutes(15),
    onBackendFailure: 'refuse',
  },

  /**
   * Pairing-code guessing. 8 characters over a 31-symbol alphabet with a
   * 10-minute TTL is already infeasible to brute force; §10.2's own words are
   * that this limit "makes it silly".
   *
   * Fails closed for the same reason as login, and it costs even less: pairing
   * a kiosk is a one-off setup step, not something a shift depends on.
   */
  deviceActivation: {
    limit: 5,
    ttl: hours(1),
    blockDuration: hours(1),
    onBackendFailure: 'refuse',
  },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Overrides the global limit for one route (§10.2).
 *
 * The outage policy rides along with the limit rather than being a second
 * decorator, so a route cannot end up with one and not the other — the pair is
 * the rule.
 */
export const RateLimit = (rule: RateLimitRule) =>
  applyDecorators(
    Throttle({ default: rule }),
    SetMetadata(RATE_LIMIT_BACKEND_POLICY, rule.onBackendFailure),
  );
