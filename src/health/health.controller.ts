import { Controller, Get, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../identity/decorators/public.decorator';
import { HealthService } from './health.service';

/**
 * Platform probes (§16). `configureApp` excludes these two paths from the
 * `/api/v1` prefix (§5.1) so orchestrators keep hitting fixed, unversioned
 * paths, and `buildLoggerOptions` keeps them out of the request log.
 *
 * Explicitly `@Public`: a kubelet has no bearer token, and the global
 * `RolesGuard` refuses any route that does not state its policy — including,
 * deliberately, this one.
 */
@Public()
// Orchestrators probe these on a fixed schedule from a small set of addresses;
// counting them against a rate limit could only ever make a node look unhealthy
// under load, which is exactly when the truth matters most.
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: is the process up? No dependency checks — a slow DB must not trigger a kill. */
  @Get('healthz')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: can we actually serve? Fails (503) if DB or Redis is unreachable. */
  @Get('readyz')
  async readiness(@Res({ passthrough: true }) res: Response) {
    const result = await this.health.checkReadiness();
    res.status(result.ok ? 200 : 503);
    return { status: result.ok ? 'ok' : 'unavailable', checks: result.checks };
  }
}
