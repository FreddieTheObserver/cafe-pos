import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

interface ReceivedSpan {
  name: string;
  scope: string;
  path: string | undefined;
}

interface OtlpPayload {
  resourceSpans?: {
    scopeSpans?: {
      scope?: { name?: string };
      spans?: {
        name: string;
        attributes?: { key: string; value?: { stringValue?: string } }[];
      }[];
    }[];
  }[];
}

async function eventually(
  assertion: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/**
 * §13's tracing, proven against the built app.
 *
 * It cannot be tested inside Jest: OpenTelemetry instruments modules through
 * Node's require hooks, which Jest's own module loader bypasses. So this starts
 * `dist/main.js` as a child process, the way production runs it, pointed at an
 * OTLP endpoint that records every span it is sent. What it guards is the one
 * thing most likely to break silently: `instrument.ts` loading after something
 * it was meant to patch, leaving tracing "on" and every layer untraced.
 */
describe('Tracing (e2e)', () => {
  const MAIN = join(__dirname, '..', 'dist', 'main.js');
  const spans: ReceivedSpan[] = [];
  let receiver: Server;
  let app: ChildProcess;
  let baseUrl: string;
  let output = '';

  beforeAll(async () => {
    if (!existsSync(MAIN)) {
      throw new Error(
        'dist/main.js is missing: run `pnpm build` first. This suite starts the built app.',
      );
    }

    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const payload = JSON.parse(body) as OtlpPayload;
        for (const resource of payload.resourceSpans ?? []) {
          for (const scoped of resource.scopeSpans ?? []) {
            for (const span of scoped.spans ?? []) {
              const path = span.attributes?.find(
                (a) => a.key === 'url.path' || a.key === 'http.target',
              )?.value?.stringValue;
              spans.push({
                name: span.name,
                scope: scoped.scope?.name ?? '',
                path,
              });
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, resolve));
    const otlpPort = (receiver.address() as AddressInfo).port;

    const apiPort = await freePort();
    const metricsPort = await freePort();
    baseUrl = `http://127.0.0.1:${apiPort}`;

    app = spawn(process.execPath, [MAIN], {
      env: {
        ...process.env,
        PORT: String(apiPort),
        METRICS_PORT: String(metricsPort),
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otlpPort}`,
        // Every trace, and exported quickly, so the test need not wait.
        OTEL_TRACES_SAMPLER_ARG: '1',
        OTEL_BSP_SCHEDULE_DELAY: '200',
      },
    });
    app.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    app.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

    try {
      await eventually(async () => {
        const res = await fetch(`${baseUrl}/readyz`);
        expect(res.status).toBe(200);
      }, 30_000);
    } catch (error) {
      throw new Error(`The built app never became ready.\n${output}`, {
        cause: error,
      });
    }
  }, 45_000);

  afterAll(async () => {
    if (app && app.exitCode === null) {
      app.kill();
      await once(app, 'exit');
    }
    await new Promise((resolve) => receiver?.close(resolve));
  });

  it('traces a request through the HTTP server, the router, Postgres and Redis', async () => {
    // Public, and it reads orders from Postgres behind the Redis-backed rate limiter.
    const res = await fetch(`${baseUrl}/api/v1/orders/board`);
    expect(res.status).toBe(200);

    await eventually(() => {
      expect([...new Set(spans.map((span) => span.scope))]).toEqual(
        expect.arrayContaining([
          '@opentelemetry/instrumentation-http',
          '@opentelemetry/instrumentation-express',
          '@opentelemetry/instrumentation-pg',
          '@opentelemetry/instrumentation-ioredis',
        ]),
      );
      return Promise.resolve();
    }, 15_000);
  });

  // Polled throughout start-up above, so a missing exclusion would have left spans here.
  it('does not trace the readiness probe', () => {
    expect(spans.filter((span) => span.path === '/readyz')).toEqual([]);
  });
});
