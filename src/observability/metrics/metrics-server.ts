import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { collectDefaultMetrics } from 'prom-client';
import { describeError } from '../../common/errors/describe-error';
import { Metrics } from './metrics';

/**
 * `GET /metrics` and nothing else, on a port the load balancer never routes.
 *
 * Started by `main.ts` rather than on module init, so the e2e suites that boot
 * `AppModule` do not each open a port. Node's default metrics are attached
 * here for the same reason: their process-wide observers are never released,
 * so only a process that actually serves them should carry them.
 */
@Injectable()
export class MetricsServer implements OnApplicationShutdown {
  private readonly logger = new Logger(MetricsServer.name);
  private server: Server | undefined;

  constructor(private readonly metrics: Metrics) {}

  /** Resolves with the bound port, so a caller that asked for 0 learns which one. */
  async listen(port: number): Promise<number> {
    if (this.server !== undefined) {
      throw new Error('The metrics server is already listening.');
    }

    collectDefaultMetrics({ register: this.metrics.registry });

    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => {
        server.off('error', reject);
        resolve();
      });
    });

    return (server.address() as AddressInfo).port;
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== '/metrics') {
      res.writeHead(404).end();
      return;
    }

    try {
      const body = await this.metrics.registry.metrics();
      res
        .writeHead(200, { 'Content-Type': this.metrics.registry.contentType })
        .end(body);
    } catch (error) {
      this.logger.error(`Could not serialise metrics. ${describeError(error)}`);
      res.writeHead(500).end();
    }
  }
}
