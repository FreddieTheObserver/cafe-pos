import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

/**
 * The first step of a zero-downtime stop (§16).
 *
 * Runs before Nest closes anything: `/readyz` starts answering 503, and the
 * process waits `SHUTDOWN_DRAIN_SECONDS` for the load balancer to notice and
 * stop routing here. Only then are the listeners closed, which drops the
 * sockets, so each screen reconnects to an instance that is staying up rather
 * than to this one.
 */
@Injectable()
export class ShutdownDrain implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ShutdownDrain.name);
  private readonly drainMs: number;
  private draining = false;

  constructor(config: ConfigService<Env, true>) {
    this.drainMs = config.get('SHUTDOWN_DRAIN_SECONDS', { infer: true }) * 1000;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.draining = true;
    if (this.drainMs === 0) return;

    this.logger.log(
      `Draining for ${this.drainMs / 1000}s before closing: /readyz now answers 503.`,
    );
    await new Promise((resolve) => setTimeout(resolve, this.drainMs));
  }
}
