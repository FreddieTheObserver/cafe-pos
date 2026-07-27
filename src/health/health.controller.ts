import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

/**
 * Platform probes (§16). `configureApp` excludes these two paths from the
 * `/api/v1` prefix (§5.1) so orchestrators keep hitting fixed, unversioned
 * paths, and `buildLoggerOptions` keeps them out of the request log.
 */
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
