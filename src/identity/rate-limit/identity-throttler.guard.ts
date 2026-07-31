import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Response } from 'express';
import { RateLimitedError } from '../../common/errors/rate-limited.error';
import type { Principal } from '../principal';

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
