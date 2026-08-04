import { Injectable, Logger, type ExecutionContext } from '@nestjs/common';
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerRequest,
} from '@nestjs/throttler';
import type { Response } from 'express';
import { DependencyUnavailableError } from '../../common/errors/dependency-unavailable.error';
import { describeError } from '../../common/errors/describe-error';
import { LogThrottle } from '../../common/logging/log-throttle';
import { RateLimitedError } from '../../common/errors/rate-limited.error';
import type { Principal } from '../principal';
import { RateLimitBackendUnavailableError } from './rate-limit-backend.error';
import {
  RATE_LIMITS,
  RATE_LIMIT_BACKEND_POLICY,
  type BackendFailurePolicy,
} from './rate-limits';

/**
 * How long the guard stays quiet about an outage it has already reported.
 *
 * The same 30s as `REDIS_ERROR_LOG_INTERVAL_MS`, for the same reason and at a
 * worse scale: this failure recurs per *request*, not per connection attempt,
 * so the staff backstop alone permits 600 lines a minute per user. An operator
 * still sees the incident open, and the count on each line says how big it is.
 */
const OUTAGE_LOG_INTERVAL_MS = 30_000;

/**
 * Applies the §10.2 limits and reports them in the §9.1 envelope.
 *
 * Registered *after* `AuthenticationGuard` so the principal exists and staff
 * can be counted per user, as §10.2 specifies, rather than per address — one
 * NAT'd cafe would otherwise share a single budget. The tradeoff is that a
 * request rejected for a bad token never reaches this guard; volumetric
 * defence against that belongs at the edge, while what §10.2 actually asks
 * for — stuffing and pairing-code guessing — happens on `@Public()` routes
 * that do reach it.
 *
 * It runs *before* `RolesGuard`, so hammering an endpoint you are not allowed
 * to call still costs you budget.
 */
@Injectable()
export class IdentityThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(IdentityThrottlerGuard.name);

  /**
   * Separate throttles so a flood of one cannot hide the other: the refusals
   * are the security-relevant half, and they would otherwise be crowded out by
   * the much larger volume of requests being served uncounted.
   */
  private readonly refusals = new LogThrottle(OUTAGE_LOG_INTERVAL_MS);
  private readonly uncounted = new LogThrottle(OUTAGE_LOG_INTERVAL_MS);

  /**
   * Decides what an unreachable limiter means for the route being called.
   *
   * This guard is global, so it runs before every handler in the application —
   * which makes an unhandled failure here a 500 on routes that have nothing to
   * do with Redis. Until this existed, one unreachable dependency took down the
   * whole API, including the menu the cache layer had carefully arranged to
   * keep serving without it.
   */
  protected async handleRequest(request: ThrottlerRequest): Promise<boolean> {
    try {
      return await super.handleRequest(request);
    } catch (error) {
      if (!(error instanceof RateLimitBackendUnavailableError)) throw error;
      return this.withoutABackend(request.context, error);
    }
  }

  private withoutABackend(
    context: ExecutionContext,
    error: RateLimitBackendUnavailableError,
  ): boolean {
    // Routes carry their policy via `@RateLimit`; everything else is running on
    // the global backstop, and takes the backstop's answer.
    const policy =
      this.reflector.getAllAndOverride<BackendFailurePolicy | undefined>(
        RATE_LIMIT_BACKEND_POLICY,
        [context.getHandler(), context.getClass()],
      ) ?? RATE_LIMITS.staffGeneral.onBackendFailure;

    /**
     * Built only when the line is actually going to be written. Everything here
     * — reading the request, and `describeError`'s walk through `cause` and
     * `errors[]` — is work in front of every handler in the application, and
     * the throttle above discards all but one call in thirty seconds of it.
     *
     * `describeError` rather than `String(error)`: the ioredis failure is one
     * layer down, under our own wrapper, and this is how the rest of the
     * codebase renders a thrown value.
     */
    const describe = (): string => {
      const { method, url } = this.getRequestResponse(context).req as {
        method: string;
        url: string;
      };
      return `(most recently ${method} ${url}). ${describeError(error)}`;
    };

    if (policy === 'refuse') {
      const suffix = this.refusals.claim();
      if (suffix !== null) {
        this.logger.error(
          `Refusing requests whose rate limit is a security control and cannot be enforced ${describe()}${suffix}`,
        );
      }
      throw new DependencyUnavailableError(
        'This request could not be rate limited, so it was refused. Try again shortly.',
      );
    }

    const suffix = this.uncounted.claim();
    if (suffix !== null) {
      this.logger.warn(
        `Serving requests uncounted until the rate limiter is reachable ${describe()}${suffix}`,
      );
    }
    return true;
  }

  /**
   * §10.2 counts staff per user and everything else per address. Kiosks are
   * counted per device for the same reason: one stolen tablet should not be
   * able to spend the whole cafe's budget (T2).
   */
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const principal = req.principal as Principal | undefined;

    if (principal?.type === 'staff')
      return Promise.resolve(`user:${principal.userId}`);
    if (principal?.type === 'device')
      return Promise.resolve(`device:${principal.deviceId}`);

    // Express sets `ip` to a string; anything else means we are behind a proxy
    // setup we do not understand, and lumping those together is safer than
    // trusting a value we cannot read.
    const ip = typeof req.ip === 'string' ? req.ip : 'unknown';
    return Promise.resolve(`ip:${ip}`);
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<never> {
    const retryAfterSeconds = detail.timeToBlockExpire || detail.timeToExpire;

    // The header as well as the body: §10.2 asks for `Retry-After`, and HTTP
    // clients and proxies act on the header without parsing JSON.
    const { res } = this.getRequestResponse(context);
    (res as Response).setHeader('Retry-After', String(retryAfterSeconds));

    return Promise.reject(new RateLimitedError(retryAfterSeconds));
  }
}
