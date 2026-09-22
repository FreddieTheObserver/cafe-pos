# Metrics and Alert Rules Implementation Plan

> **For agentic workers:** Execute the tasks in order. Each task ends green and committed, and each is reviewable on its own. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the §13 metrics on a port of their own, turn §13's alerts into Prometheus rules with tests that can fail, and give local development a Prometheus and Grafana to watch them in.

**Architecture:** One `Metrics` facade per app owns a private prom-client `Registry` and every counter and histogram. Producers increment it only after the fact they count has committed. Gauges that describe state rather than events are `ScrapedGauge`s: read from their source when Prometheus scrapes, and exported with no value, never a stale one, when that read fails. A second HTTP listener, `MetricsServer`, serves `GET /metrics` and nothing else.

**Tech Stack:** NestJS 11 on Express 5.2, prom-client 15.1.3, Drizzle ORM over node-postgres, Zod v4, Jest (unit + e2e), Prometheus v3.14.0 and promtool, Grafana 13.2.2.

**Spec:** `docs/superpowers/specs/2026-09-22-phase7-metrics-design.md`

## Global Constraints

- Branch is `phase7-metrics`, already created off `main` and carrying the spec commit. Do not merge; the user merges.
- **Commit messages carry no `Co-Authored-By` trailer.** Repo style is a sentence in the imperative (`Serve the kitchen its worklist`), no conventional-commit prefixes.
- **No em dash (U+2014) anywhere this plan writes**: code comments, docs, YAML, JSON, commit messages. Use a plain `-`.
- Comments explain *why*, and only where the code cannot. No docstring above every function.
- Before every commit, all three must be clean:
  - `pnpm typecheck`
  - `pnpm exec eslint "{src,test}/**/*.ts"` (the CI command; it does not `--fix`)
  - `pnpm test` (unit)
- Do NOT run `pnpm format`: it rewrites the whole repo's line endings on Windows. Use `npx prettier --write <specific paths>`.
- **E2E needs the compose stack and an explicit gateway.** Docker Desktop must be running, then `docker compose up -d` and `pnpm db:migrate`. Run a suite with:
  `NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 npx jest --config ./test/jest-e2e.json <file>`
  Without `STRIPE_API_BASE` the payment suites talk to real Stripe test mode, because `.env` does not set it.
- **Never `pnpm test:e2e -- <file> -t <name>`.** The double `--` turns `-t` into a path pattern, runs unrelated suites and spends the shared login budget. Use `npx jest --config ./test/jest-e2e.json <file> -t "<name>"`.
- **New e2e code never logs in.** Use `harness.tokenFor(role)`, never `accessTokenFor`: every suite shares one per-address login budget that outlives the process.
- Local Postgres is on host port 5433 and CI's is on 5432. Take it from `.env`; never hardcode it.
- New dependencies: `prom-client` (Task 1) and `yaml` as a devDependency (Task 10). Nothing else.
- **Every domain counter moves after its transaction commits, and only when its guarded write matched a row** (spec decision 6). A reviewer should treat an increment inside a transaction callback as a defect.
- **The tests this plan prescribes are its weakest part.** Six of Phase 6's defects were prescribed tests that could not fail. Every load-bearing test below names the wrong implementation it rules out, and its task ends with a falsification step: break the code that way, watch the test go red, then restore it. A reviewer who finds a prescribed test that cannot fail should report it as a finding, even though the plan asked for it.

---

### Task 1: Give the app a registry of its own, and a port to serve it on

The core every later task builds on: the `Metrics` facade with a private registry, `ScrapedGauge`, and `MetricsServer`. Reviewable on one question: does `/metrics` exist only on its own port, and does each app get its own registry?

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (via `pnpm add`)
- Create: `src/observability/metrics/scraped-gauge.ts`
- Create: `src/observability/metrics/scraped-gauge.spec.ts`
- Create: `src/observability/metrics/metrics.ts`
- Create: `src/observability/metrics/sample-of.ts`
- Create: `src/observability/metrics/metrics-server.ts`
- Create: `src/observability/metrics/metrics.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/main.ts`
- Modify: `src/config/env.validation.ts`
- Modify: `src/config/env.validation.spec.ts`
- Modify: `.env.example`
- Create: `test/metrics.e2e-spec.ts`
- Modify: `test/realtime-two-instances.e2e-spec.ts`

**Interfaces:**
- Produces: `Metrics` (`registry`, `collectorFailures`, `scraped(config, read)`), `ScrapedGauge`, `Sample<T>`, `Read<T>`, `sampleOf(metrics, series, labels?)`, `MetricsServer.listen(port): Promise<number>`, `MetricsModule` (global), and env `METRICS_PORT`. Every later task relies on these.

- [ ] **Step 1: Add the dependency**

```bash
pnpm add prom-client@^15.1.3
```

Confirm `package.json` gains exactly `"prom-client": "^15.1.3"` under `dependencies`.

- [ ] **Step 2: Write the failing unit test for `ScrapedGauge`**

Create `src/observability/metrics/scraped-gauge.spec.ts`:

```ts
import { Counter, Registry } from 'prom-client';
import { ScrapedGauge } from './scraped-gauge';

const setup = () => {
  const registry = new Registry();
  const failures = new Counter({
    name: 'metrics_collector_failures_total',
    help: 'test',
    labelNames: ['collector'] as const,
    registers: [registry],
  });
  return { registry, failures };
};

const valuesOf = async (registry: Registry, name: string) =>
  (await registry.getMetricsAsJSON()).find((metric) => metric.name === name)
    ?.values ?? [];

// Read off the counter itself: going through the registry would scrape again,
// re-run the failing read, and count one failure more than the test caused.
const failuresOf = async (failures: Counter<'collector'>, collector: string) =>
  (await failures.get()).values.find(
    (value) => value.labels.collector === collector,
  )?.value;

describe('ScrapedGauge', () => {
  it('exports what the read returned', async () => {
    const { registry, failures } = setup();
    new ScrapedGauge(
      { name: 'answer', help: 'test', registers: [registry] },
      () => [{ labels: {}, value: 42 }],
      failures,
    );

    expect(await valuesOf(registry, 'answer')).toEqual([
      { labels: {}, value: 42 },
    ]);
  });

  it('reads again on every scrape', async () => {
    const { registry, failures } = setup();
    let reads = 0;
    new ScrapedGauge(
      { name: 'reads', help: 'test', registers: [registry] },
      () => [{ labels: {}, value: ++reads }],
      failures,
    );

    await valuesOf(registry, 'reads');
    expect(await valuesOf(registry, 'reads')).toEqual([
      { labels: {}, value: 2 },
    ]);
  });

  // prom-client's reset() would have exported 0 here, a number nobody measured.
  it('exports no value, not zero, when the read throws', async () => {
    const { registry, failures } = setup();
    new ScrapedGauge(
      { name: 'broken', help: 'test', registers: [registry] },
      () => Promise.reject(new Error('database is down')),
      failures,
    );

    expect(await valuesOf(registry, 'broken')).toEqual([]);
    expect(await failuresOf(failures, 'broken')).toBe(1);
  });

  it('exports no value when the read outlives its deadline', async () => {
    const { registry, failures } = setup();
    new ScrapedGauge(
      { name: 'slow', help: 'test', registers: [registry] },
      () => new Promise<never>(() => {}),
      failures,
      20,
    );

    expect(await valuesOf(registry, 'slow')).toEqual([]);
    expect(await failuresOf(failures, 'slow')).toBe(1);
  });

  it('does not fall back to the last value it read', async () => {
    const { registry, failures } = setup();
    let failing = false;
    new ScrapedGauge(
      { name: 'flaky', help: 'test', registers: [registry] },
      () =>
        failing
          ? Promise.reject(new Error('gone'))
          : [{ labels: {}, value: 7 }],
      failures,
    );

    expect(await valuesOf(registry, 'flaky')).toEqual([
      { labels: {}, value: 7 },
    ]);
    failing = true;
    expect(await valuesOf(registry, 'flaky')).toEqual([]);
  });

  // A failed read must not fail the scrape, or Prometheus reports the instance down.
  it('serves the rest of the scrape when one read fails', async () => {
    const { registry, failures } = setup();
    new ScrapedGauge(
      { name: 'broken', help: 'test', registers: [registry] },
      () => Promise.reject(new Error('gone')),
      failures,
    );
    new ScrapedGauge(
      { name: 'fine', help: 'test', registers: [registry] },
      () => [{ labels: {}, value: 1 }],
      failures,
    );

    const text = await registry.metrics();
    expect(text).toMatch(/^fine 1$/m);
    expect(text).not.toMatch(/^broken /m);
  });

  it('exports its failure count at zero before anything has failed', async () => {
    const { registry, failures } = setup();
    new ScrapedGauge(
      { name: 'healthy', help: 'test', registers: [registry] },
      () => [{ labels: {}, value: 1 }],
      failures,
    );

    expect(await failuresOf(failures, 'healthy')).toBe(0);
  });
});
```

Run: `pnpm test -- src/observability/metrics/scraped-gauge.spec.ts`
Expected: FAIL, `Cannot find module './scraped-gauge'`.

- [ ] **Step 3: Implement `ScrapedGauge`**

Create `src/observability/metrics/scraped-gauge.ts`:

```ts
import { Logger } from '@nestjs/common';
import { Gauge, type Counter, type GaugeConfiguration } from 'prom-client';
import { describeError } from '../../common/errors/describe-error';
import { LogThrottle } from '../../common/logging/log-throttle';

export interface Sample<T extends string> {
  labels: Partial<Record<T, string | number>>;
  value: number;
}

export type Read<T extends string> = () => Sample<T>[] | Promise<Sample<T>[]>;

const DEFAULT_DEADLINE_MS = 2000;

// A dead database fails every read on every scrape; one line a minute is enough to say so.
const FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * A gauge read at scrape time that exports nothing, never a stale value and
 * never zero, when its read fails.
 *
 * prom-client's `reset()` puts an unlabelled gauge back to 0, so its own
 * `collect` hook cannot say "unknown": a failed read would publish a zero
 * nobody measured. Overriding `get()` bypasses the stored values entirely, so
 * what is exported is exactly what this scrape read.
 */
export class ScrapedGauge<T extends string = string> extends Gauge<T> {
  private readonly logger = new Logger('Metrics');
  private readonly failureLog = new LogThrottle(FAILURE_LOG_INTERVAL_MS);
  private readonly collector: string;

  constructor(
    config: Omit<GaugeConfiguration<T>, 'collect'>,
    private readonly read: Read<T>,
    private readonly failures: Counter<'collector'>,
    private readonly deadlineMs: number = DEFAULT_DEADLINE_MS,
  ) {
    super(config);
    this.collector = config.name;
    failures.inc({ collector: config.name }, 0);
  }

  override async get() {
    const metric = await super.get();
    return { ...metric, values: await this.readOrNothing() };
  }

  private async readOrNothing(): Promise<Sample<T>[]> {
    try {
      return await withDeadline(
        Promise.resolve().then(() => this.read()),
        this.deadlineMs,
      );
    } catch (error) {
      this.failures.inc({ collector: this.collector });
      const suffix = this.failureLog.claim();
      if (suffix !== null) {
        this.logger.warn(
          `Could not read ${this.collector}; exporting no value. ${describeError(error)}${suffix}`,
        );
      }
      return [];
    }
  }
}

function withDeadline<V>(work: Promise<V>, ms: number): Promise<V> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`read exceeded its ${ms}ms deadline`)),
      ms,
    );
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
```

Run: `pnpm test -- src/observability/metrics/scraped-gauge.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 4: Add the facade, the test reader, the server and the module**

Create `src/observability/metrics/metrics.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Counter, Registry } from 'prom-client';
import { ScrapedGauge, type Read } from './scraped-gauge';

export interface ScrapedGaugeConfig<T extends string> {
  name: string;
  help: string;
  labelNames?: readonly T[];
  deadlineMs?: number;
}

/**
 * Every instrument the app exports, on a registry of its own.
 *
 * Per app rather than prom-client's global registry: the two-instance suite
 * boots two `AppModule`s in one process, and a shared registry would either
 * refuse the second boot or let two instances count into one series.
 */
@Injectable()
export class Metrics {
  readonly registry = new Registry();

  readonly collectorFailures = new Counter({
    name: 'metrics_collector_failures_total',
    help: 'Scrape-time reads that failed or overran their deadline, by gauge.',
    labelNames: ['collector'] as const,
    registers: [this.registry],
  });

  scraped<T extends string>(
    config: ScrapedGaugeConfig<T>,
    read: Read<T>,
  ): ScrapedGauge<T> {
    const { deadlineMs, ...gauge } = config;
    return new ScrapedGauge<T>(
      { ...gauge, registers: [this.registry] },
      read,
      this.collectorFailures,
      deadlineMs,
    );
  }
}
```

Create `src/observability/metrics/sample-of.ts`:

```ts
import type { Metrics } from './metrics';

/**
 * Reads one exported series the way a scrape would.
 *
 * Goes through `getMetricsAsJSON`, which calls every metric's `get()`, so a
 * scraped gauge is read from its source rather than from anything stored.
 * `undefined` means the series is not exported at all, which several tests
 * assert on purpose.
 */
export async function sampleOf(
  metrics: Metrics,
  series: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  for (const metric of await metrics.registry.getMetricsAsJSON()) {
    for (const value of metric.values) {
      const name =
        (value as { metricName?: string }).metricName ?? metric.name;
      if (name === series && sameLabels(value.labels, labels)) {
        return value.value;
      }
    }
  }
  return undefined;
}

function sameLabels(
  actual: Partial<Record<string, string | number>>,
  expected: Record<string, string>,
): boolean {
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => String(actual[key]) === expected[key])
  );
}
```

Create `src/observability/metrics/metrics-server.ts`:

```ts
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
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
```

Create `src/observability/metrics/metrics.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { Metrics } from './metrics';
import { MetricsServer } from './metrics-server';

/**
 * Global, and deliberately dependency-free: `configureApp` reads `Metrics`, and
 * the probe-module suite runs `configureApp` without a database or Redis.
 */
@Global()
@Module({
  providers: [Metrics, MetricsServer],
  exports: [Metrics, MetricsServer],
})
export class MetricsModule {}
```

In `src/app.module.ts`, import `MetricsModule` from `./observability/metrics/metrics.module` and add it to `imports` directly after `ScheduleModule.forRoot(),`.

- [ ] **Step 5: Add `METRICS_PORT`, with a failing test first**

In `src/config/env.validation.spec.ts`, add inside `describe('validateEnv')`:

```ts
  describe('METRICS_PORT', () => {
    it('defaults to a port of its own', () => {
      expect(validateEnv({ ...REQUIRED }).METRICS_PORT).toBe(9464);
    });

    it('refuses to share the API port', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, PORT: '9000', METRICS_PORT: '9000' }),
      ).toThrow(/METRICS_PORT/);
    });

    it('rejects a port outside the TCP range', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, METRICS_PORT: '70000' }),
      ).toThrow(/METRICS_PORT/);
    });
  });
```

Run: `pnpm test -- src/config/env.validation.spec.ts`
Expected: FAIL on all three.

In `src/config/env.validation.ts`, add directly after `PORT`:

```ts
  /**
   * The second listener, serving only `GET /metrics`. A port of its own so the
   * load balancer, which routes PORT, never exposes it.
   */
  METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
```

Replace `validateEnv` with:

```ts
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw invalidEnv(
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }

  const conflicts = conflictsIn(result.data);
  if (conflicts.length > 0) throw invalidEnv(conflicts);

  return result.data;
}

/**
 * Rules that span two variables, checked once both have parsed.
 *
 * Kept off the schema: `ConfigService` infers its types from the schema's
 * shape, and this file has already lost that inference once to a refinement
 * placed where it changed the shape.
 */
function conflictsIn(env: Env): string[] {
  const conflicts: string[] = [];
  if (env.METRICS_PORT === env.PORT) {
    conflicts.push(
      'METRICS_PORT: must differ from PORT, or /metrics and the API would contend for one listener',
    );
  }
  return conflicts;
}

function invalidEnv(lines: string[]): Error {
  const details = lines.map((line) => `  - ${line}`).join('\n');
  return new Error(`Invalid environment variables:\n${details}`);
}
```

Run: `pnpm test -- src/config/env.validation.spec.ts`
Expected: PASS, including the existing "names every missing variable in one readable message".

In `.env.example`, directly after `PORT=3000`, add:

```
# Serves GET /metrics for Prometheus, and nothing else. Only PORT belongs on
# the load balancer; this one stays on the private network.
# METRICS_PORT=9464
```

- [ ] **Step 6: Start the listener in `main.ts`**

In `src/main.ts`, import `MetricsServer` from `./observability/metrics/metrics-server` and replace the last line of `bootstrap()`:

```ts
  await app.listen(config.get('PORT', { infer: true }));
  await app
    .get(MetricsServer)
    .listen(config.get('METRICS_PORT', { infer: true }));
```

- [ ] **Step 7: Write the e2e suite**

Create `test/metrics.e2e-spec.ts`:

```ts
import request from 'supertest';
import { MetricsServer } from '../src/observability/metrics/metrics-server';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * The metrics endpoint against the real app. Later sections of this file
 * cover each family of metrics where no other suite already produces the
 * event being counted.
 */
describe('Metrics (e2e)', () => {
  let harness: IdentityHarness;
  let metricsUrl: string;

  const scrape = async (): Promise<string> => {
    const res = await request(metricsUrl).get('/metrics');
    expect(res.status).toBe(200);
    return res.text;
  };

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    const port = await harness.app.get(MetricsServer).listen(0);
    metricsUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('the endpoint', () => {
    it('serves the Prometheus text format on its own port', async () => {
      const res = await request(metricsUrl).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.text).toContain(
        '# TYPE metrics_collector_failures_total counter',
      );
    });

    it('serves nothing else on that port', async () => {
      expect((await request(metricsUrl).get('/')).status).toBe(404);
      expect((await request(metricsUrl).post('/metrics')).status).toBe(404);
    });

    it('is not reachable through the API port', async () => {
      expect((await harness.http().get('/metrics')).status).toBe(404);
      expect((await harness.http().get('/api/v1/metrics')).status).toBe(404);
    });

    it('exports the Node process metrics alongside its own', async () => {
      expect(await scrape()).toContain(
        '# TYPE nodejs_eventloop_lag_p99_seconds gauge',
      );
    });
  });
});
```

In `test/realtime-two-instances.e2e-spec.ts`, import `Metrics` from `../src/observability/metrics/metrics` and `sampleOf` from `../src/observability/metrics/sample-of`, then add as the last test in the top-level `describe`:

```ts
  // A shared registry would merge the two instances' counts into one series.
  it("keeps each instance's metrics to itself", async () => {
    const mine = writer.app.get(Metrics);
    const theirs = reader.app.get(Metrics);
    const collector = 'isolation-probe';

    mine.collectorFailures.inc({ collector });

    expect(
      await sampleOf(mine, 'metrics_collector_failures_total', { collector }),
    ).toBe(1);
    expect(
      await sampleOf(theirs, 'metrics_collector_failures_total', { collector }),
    ).toBeUndefined();
  });
```

Run both: `NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 npx jest --config ./test/jest-e2e.json test/metrics.e2e-spec.ts test/realtime-two-instances.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 8: Falsify the registry isolation**

In `metrics.ts`, temporarily replace `new Registry()` with prom-client's global `register` (import `register` from `prom-client` and use `readonly registry = register;`). Run the two-instance suite **with `--forceExit`**: the failed second boot leaves the first app open, and without the flag Jest never exits. Expected: RED, the second boot throws `A metric with the name metrics_collector_failures_total has already been registered`. Restore `new Registry()`, re-run, green.

- [ ] **Step 9: Verify and commit**

Run typecheck, lint and unit tests (Global Constraints).

```bash
git add package.json pnpm-lock.yaml src/observability src/app.module.ts src/main.ts src/config .env.example test/metrics.e2e-spec.ts test/realtime-two-instances.e2e-spec.ts
git commit -m "Give the app a registry of its own and a port to serve it on"
```

---

### Task 2: Time every request by the route it matched

The RED half of §13. The label is Express's matched pattern, which the Phase 7 probe confirmed on Express 5.2.1: `req.route.path` reads `/api/v1/orders/:id` for any id, survives a guard's 401, and is absent on an unmatched 404.

**Files:**
- Modify: `src/observability/metrics/metrics.ts`
- Create: `src/observability/metrics/http-metrics.ts`
- Create: `src/observability/metrics/http-metrics.spec.ts`
- Modify: `src/bootstrap.ts`
- Modify: `test/http-hardening.e2e-spec.ts`
- Modify: `test/metrics.e2e-spec.ts`

**Interfaces:**
- Produces: `Metrics.httpRequestDuration`; `timeHttpRequests(metrics)`, `routeLabelOf(req)`, `statusClassOf(code)`.

- [ ] **Step 1: Write the failing unit test**

Create `src/observability/metrics/http-metrics.spec.ts`:

```ts
import { routeLabelOf, statusClassOf } from './http-metrics';

describe('routeLabelOf', () => {
  it('names the pattern the router matched', () => {
    expect(
      routeLabelOf({ baseUrl: '', route: { path: '/api/v1/orders/:id' } }),
    ).toBe('/api/v1/orders/:id');
  });

  it("keeps a mounted router's base path", () => {
    expect(routeLabelOf({ baseUrl: '/api', route: { path: '/orders' } })).toBe(
      '/api/orders',
    );
  });

  // A scanner walking random paths must not mint a series per path.
  it('collapses every unmatched request into one label', () => {
    expect(routeLabelOf({ baseUrl: '', route: undefined })).toBe('unmatched');
  });
});

describe('statusClassOf', () => {
  it.each([
    [200, '2xx'],
    [201, '2xx'],
    [304, '3xx'],
    [404, '4xx'],
    [429, '4xx'],
    [503, '5xx'],
  ])('files %i under %s', (status, statusClass) => {
    expect(statusClassOf(status)).toBe(statusClass);
  });
});
```

Run: `pnpm test -- src/observability/metrics/http-metrics.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement the middleware and the histogram**

Create `src/observability/metrics/http-metrics.ts`:

```ts
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Metrics } from './metrics';

// Excluded from the request log for the same reason: they fire constantly.
const UNTIMED_PATHS = new Set(['/healthz', '/readyz']);

export function routeLabelOf(req: Pick<Request, 'baseUrl' | 'route'>): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  return typeof pattern === 'string' ? `${req.baseUrl}${pattern}` : 'unmatched';
}

export function statusClassOf(statusCode: number): string {
  return `${Math.floor(statusCode / 100)}xx`;
}

export function timeHttpRequests(metrics: Metrics): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (UNTIMED_PATHS.has(req.path)) {
      next();
      return;
    }

    const end = metrics.httpRequestDuration.startTimer();
    // Read at finish, not now: the router has not matched a route yet.
    res.once('finish', () => {
      end({
        method: req.method,
        route: routeLabelOf(req),
        status_class: statusClassOf(res.statusCode),
      });
    });
    next();
  };
}
```

In `src/observability/metrics/metrics.ts`, add `Histogram` to the prom-client import and add this field after `collectorFailures`:

```ts
  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'API response time, by the route pattern the request matched.',
    labelNames: ['method', 'route', 'status_class'] as const,
    // 0.3 is an edge so the 300 ms alert reads a boundary instead of interpolating across one.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
```

Run: `pnpm test -- src/observability/metrics/http-metrics.spec.ts`
Expected: PASS.

- [ ] **Step 3: Install it in `configureApp`**

In `src/bootstrap.ts`, import `Metrics` from `./observability/metrics/metrics` and `timeHttpRequests` from `./observability/metrics/http-metrics`. Make this the first statement of `configureApp`, before `setGlobalPrefix`:

```ts
  // First, so a request any later layer refuses (an oversized body, say) is still timed.
  app.use(timeHttpRequests(app.get(Metrics)));
```

In `test/http-hardening.e2e-spec.ts`, import `MetricsModule` from `../src/observability/metrics/metrics.module` and add it to the testing module's `imports`: `[ProbeModule, StubbedHealthModule, MetricsModule]`.

- [ ] **Step 4: Write the e2e tests**

In `test/metrics.e2e-spec.ts`, add imports:

```ts
import { uuidv7 } from 'uuidv7';
import { Metrics } from '../src/observability/metrics/metrics';
import { sampleOf } from '../src/observability/metrics/sample-of';
```

and add inside the top-level `describe`:

```ts
  describe('request timing', () => {
    const countOf = (labels: Record<string, string>) =>
      sampleOf(
        harness.app.get(Metrics),
        'http_request_duration_seconds_count',
        labels,
      );

    // Unauthenticated, so each answers 401. The route still matched: guards run inside it.
    it('labels a request by the route it matched, not the path it asked for', async () => {
      const series = {
        method: 'GET',
        route: '/api/v1/orders/:id',
        status_class: '4xx',
      };
      const before = (await countOf(series)) ?? 0;

      await harness.http().get(`/api/v1/orders/${uuidv7()}`);
      await harness.http().get(`/api/v1/orders/${uuidv7()}`);

      expect(await countOf(series)).toBe(before + 2);
      expect(await scrape()).not.toMatch(
        /route="\/api\/v1\/orders\/[0-9a-f]{8}-/,
      );
    });

    it('labels a request that matched no route as unmatched', async () => {
      const series = { method: 'GET', route: 'unmatched', status_class: '4xx' };
      const before = (await countOf(series)) ?? 0;

      await harness.http().get(`/api/v1/no-such-route-${uuidv7()}`);

      expect(await countOf(series)).toBe(before + 1);
    });

    it('does not time the health probes', async () => {
      await harness.http().get('/healthz');

      expect(await scrape()).not.toContain('route="/healthz"');
    });
  });
```

Run: `NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 npx jest --config ./test/jest-e2e.json test/metrics.e2e-spec.ts test/http-hardening.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 5: Falsify the route label**

Temporarily make `routeLabelOf` return `req.path` (add `'path'` to its `Pick`). Expected: RED on "labels a request by the route it matched", because the count for `/api/v1/orders/:id` stays at `before`. Restore, green.

- [ ] **Step 6: Verify and commit**

Run the full e2e suite once here (`NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 pnpm test:e2e`), since `configureApp` is shared by every suite. Expected: all green. Then typecheck, lint, unit tests.

```bash
git add src/observability src/bootstrap.ts test/http-hardening.e2e-spec.ts test/metrics.e2e-spec.ts
git commit -m "Time every request by the route it matched"
```

---

### Task 3: Know when the cafe is open

Pure, with no metrics yet. Reviewable on one question: does `isOpenAt` read the local wall clock, edges included, in a zone whose offset moves?

**Files:**
- Create: `src/orders/business-hours.ts`
- Create: `src/orders/business-hours.spec.ts`
- Modify: `src/config/env.validation.ts`
- Modify: `src/config/env.validation.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `isOpenAt(instant, hours): boolean`, `OpeningHours`, `CLOCK_TIME`; env `BUSINESS_OPEN_TIME`, `BUSINESS_CLOSE_TIME` (strings, `HH:MM`). Task 4 relies on all of these.

- [ ] **Step 1: Write the failing unit test**

Create `src/orders/business-hours.spec.ts`:

```ts
import { isOpenAt, type OpeningHours } from './business-hours';

const at = (iso: string) => new Date(iso);

/** UTC+7 all year: the boring baseline. */
const BANGKOK_DAY: OpeningHours = {
  timeZone: 'Asia/Bangkok',
  open: '07:00',
  close: '20:00',
};

describe('isOpenAt', () => {
  it('is open during the day', () => {
    // 17:00 local.
    expect(isOpenAt(at('2026-06-11T10:00:00Z'), BANGKOK_DAY)).toBe(true);
  });

  it('opens on the opening minute, not after it', () => {
    // 06:59 and 07:00 local.
    expect(isOpenAt(at('2026-06-10T23:59:00Z'), BANGKOK_DAY)).toBe(false);
    expect(isOpenAt(at('2026-06-11T00:00:00Z'), BANGKOK_DAY)).toBe(true);
  });

  it('is closed from the closing minute', () => {
    // 19:59 and 20:00 local.
    expect(isOpenAt(at('2026-06-11T12:59:00Z'), BANGKOK_DAY)).toBe(true);
    expect(isOpenAt(at('2026-06-11T13:00:00Z'), BANGKOK_DAY)).toBe(false);
  });

  describe('a window that wraps past midnight', () => {
    const LATE: OpeningHours = {
      timeZone: 'Asia/Bangkok',
      open: '18:00',
      close: '02:00',
    };

    it('is open either side of midnight', () => {
      // 20:00 and 01:30 local.
      expect(isOpenAt(at('2026-06-11T13:00:00Z'), LATE)).toBe(true);
      expect(isOpenAt(at('2026-06-11T18:30:00Z'), LATE)).toBe(true);
    });

    it('is closed between the close and the next open', () => {
      // 02:00 and 12:00 local.
      expect(isOpenAt(at('2026-06-11T19:00:00Z'), LATE)).toBe(false);
      expect(isOpenAt(at('2026-06-11T05:00:00Z'), LATE)).toBe(false);
    });
  });

  /**
   * The case a UTC-naive implementation gets wrong, in both directions: in
   * British Summer Time 06:30 UTC is 07:30 on the wall, and 19:30 UTC is 20:30.
   */
  describe('in a zone with daylight saving', () => {
    const LONDON: OpeningHours = {
      timeZone: 'Europe/London',
      open: '07:00',
      close: '20:00',
    };

    it('reads the summer wall clock', () => {
      expect(isOpenAt(at('2026-07-01T06:30:00Z'), LONDON)).toBe(true);
      expect(isOpenAt(at('2026-07-01T19:30:00Z'), LONDON)).toBe(false);
    });

    it('reads the winter wall clock', () => {
      expect(isOpenAt(at('2026-01-15T06:30:00Z'), LONDON)).toBe(false);
      expect(isOpenAt(at('2026-01-15T19:30:00Z'), LONDON)).toBe(true);
    });
  });

  it('refuses a time that is not HH:MM', () => {
    expect(() =>
      isOpenAt(at('2026-06-11T10:00:00Z'), { ...BANGKOK_DAY, open: '7:00' }),
    ).toThrow(/HH:MM/);
  });
});
```

Run: `pnpm test -- src/orders/business-hours.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement it**

Create `src/orders/business-hours.ts`:

```ts
/** A 24-hour `HH:MM`. Shared with the env schema so the two cannot disagree. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface OpeningHours {
  timeZone: string;
  /** `HH:MM` on the wall clock of `timeZone`. */
  open: string;
  close: string;
}

/**
 * Whether the cafe is open at `instant`: inside `[open, close)` on the local
 * wall clock, wrapping past midnight when `close` is earlier than `open`.
 */
export function isOpenAt(instant: Date, hours: OpeningHours): boolean {
  const now = minuteOfDay(instant, hours.timeZone);
  const open = minutesOf(hours.open);
  const close = minutesOf(hours.close);

  return open < close
    ? now >= open && now < close
    : now >= open || now < close;
}

function minutesOf(clockTime: string): number {
  const match = CLOCK_TIME.exec(clockTime);
  if (match === null) {
    throw new Error(`"${clockTime}" is not a 24-hour HH:MM time`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function minuteOfDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`Intl did not return a "${type}" part for ${timeZone}`);
    }
    return Number(part.value);
  };

  return read('hour') * 60 + read('minute');
}
```

Run: `pnpm test -- src/orders/business-hours.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 3: Add the env variables, test first**

In `src/config/env.validation.spec.ts`, add inside `describe('validateEnv')`:

```ts
  describe('opening hours', () => {
    it('defaults to the 07:00-20:00 window §3 states its availability against', () => {
      const env = validateEnv({ ...REQUIRED });

      expect(env.BUSINESS_OPEN_TIME).toBe('07:00');
      expect(env.BUSINESS_CLOSE_TIME).toBe('20:00');
    });

    it('rejects a time that is not HH:MM', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, BUSINESS_OPEN_TIME: '7am' }),
      ).toThrow(/BUSINESS_OPEN_TIME/);
    });

    it('rejects an hour past 23', () => {
      expect(() =>
        validateEnv({ ...REQUIRED, BUSINESS_CLOSE_TIME: '24:00' }),
      ).toThrow(/BUSINESS_CLOSE_TIME/);
    });

    it('accepts a window that wraps past midnight', () => {
      const env = validateEnv({
        ...REQUIRED,
        BUSINESS_OPEN_TIME: '18:00',
        BUSINESS_CLOSE_TIME: '02:00',
      });

      expect(env.BUSINESS_CLOSE_TIME).toBe('02:00');
    });

    it('rejects a window that opens and closes on the same minute', () => {
      expect(() =>
        validateEnv({
          ...REQUIRED,
          BUSINESS_OPEN_TIME: '09:00',
          BUSINESS_CLOSE_TIME: '09:00',
        }),
      ).toThrow(/BUSINESS_CLOSE_TIME/);
    });
  });
```

Run: `pnpm test -- src/config/env.validation.spec.ts`
Expected: FAIL on the new cases.

In `src/config/env.validation.ts`, import `CLOCK_TIME` from `../orders/business-hours`, and add above `envSchema`:

```ts
const clockTime = z.string().regex(CLOCK_TIME, 'must be a 24-hour HH:MM time');
```

Add directly after `ORDER_EXPIRY_SECONDS`:

```ts
  /**
   * When the cafe opens and closes, `HH:MM` in BUSINESS_TIMEZONE. Read only by
   * the alerts that mean nothing overnight: no orders, no kitchen screen, a
   * kiosk offline. A close earlier than the open wraps past midnight.
   */
  BUSINESS_OPEN_TIME: clockTime.default('07:00'),
  BUSINESS_CLOSE_TIME: clockTime.default('20:00'),
```

In `conflictsIn`, add:

```ts
  if (env.BUSINESS_OPEN_TIME === env.BUSINESS_CLOSE_TIME) {
    conflicts.push(
      'BUSINESS_CLOSE_TIME: must differ from BUSINESS_OPEN_TIME; a window that opens and closes on the same minute has no single meaning',
    );
  }
```

Run: `pnpm test -- src/config/env.validation.spec.ts`
Expected: PASS.

In `.env.example`, add to the trading block's legend, after the `ORDER_EXPIRY_SECONDS` entry:

```
#   BUSINESS_OPEN_TIME      When the cafe opens and closes, HH:MM local. Read
#   BUSINESS_CLOSE_TIME     only by the alerts that mean nothing overnight. A
#                           close earlier than the open wraps past midnight.
```

and after `# ORDER_EXPIRY_SECONDS=600`:

```
# BUSINESS_OPEN_TIME=07:00
# BUSINESS_CLOSE_TIME=20:00
```

- [ ] **Step 4: Falsify the wall clock**

Temporarily change `minuteOfDay` to return `instant.getUTCHours() * 60 + instant.getUTCMinutes()`. Expected: RED across the Bangkok and London cases. Restore, green.

- [ ] **Step 5: Verify and commit**

```bash
git add src/orders/business-hours.ts src/orders/business-hours.spec.ts src/config .env.example
git commit -m "Know when the cafe is open"
```

---

### Task 4: Read the state no event announces

The gauges read at scrape time: opening hours, dependencies, unpaid orders past expiry, the oldest unhandled webhook event, and kiosk ages. Reviewable on one question: does each read its source directly, and does a failed read export nothing?

**Files:**
- Modify: `src/health/health.module.ts`
- Create: `src/observability/metrics/state-gauges.ts`
- Create: `src/observability/metrics/state-gauges.module.ts`
- Modify: `src/app.module.ts`
- Modify: `test/metrics.e2e-spec.ts`
- Modify: `test/redis-outage-http.e2e-spec.ts`

**Interfaces:**
- Consumes: `Metrics.scraped`, `isOpenAt`, `HealthService.checkReadiness`, `DRIZZLE`.
- Produces: gauges `business_open`, `dependency_up{dependency}`, `orders_pending_payment_overdue_seconds`, `payment_inbox_oldest_unprocessed_age_seconds`, `kiosk_last_seen_age_seconds{device}`.

- [ ] **Step 1: Export the readiness checks**

In `src/health/health.module.ts`, add `exports: [HealthService]` to the `@Module` metadata.

- [ ] **Step 2: Write the failing e2e tests**

In `test/metrics.e2e-spec.ts`, add imports:

```ts
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { eq, inArray } from 'drizzle-orm';
import type { Env } from '../src/config/env.validation';
import * as schema from '../src/database/schema';
import type { OrderStatus } from '../src/database/schema/enums';
import { isOpenAt } from '../src/orders/business-hours';
```

and add inside the top-level `describe`:

```ts
  describe('state read at scrape time', () => {
    // Older than any row this project has written, so in a shared database
    // nothing else can outrank a fixture and each reading can be pinned exactly.
    const DAYS = 400;
    const DAY_SECONDS = 86_400;
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * DAY_SECONDS * 1000);
    const read = (name: string, labels?: Record<string, string>) =>
      sampleOf(harness.app.get(Metrics), name, labels);

    const eventIds: string[] = [];
    let cashierId: string;

    beforeAll(async () => {
      // Both jobs would act on the fixtures below between the insert and the scrape.
      const scheduler = harness.app.get(SchedulerRegistry);
      await scheduler.getCronJob('expire-pending-orders').stop();
      await scheduler.getCronJob('drain-payment-inbox').stop();
      cashierId = (await harness.createStaff('CASHIER')).id;
    });

    afterAll(async () => {
      if (eventIds.length > 0) {
        await harness.db
          .delete(schema.paymentEvents)
          .where(inArray(schema.paymentEvents.providerEventId, eventIds));
      }
      await harness.purgeOrders();
    });

    it('reads the oldest unprocessed inbox event, and ignores processed ones', async () => {
      const unprocessed = `evt_metrics_${uuidv7()}`;
      const processed = `evt_metrics_${uuidv7()}`;
      eventIds.push(unprocessed, processed);
      await harness.db.insert(schema.paymentEvents).values([
        {
          providerEventId: unprocessed,
          eventType: 'payment_intent.succeeded',
          payload: {},
          receivedAt: daysAgo(DAYS),
        },
        {
          providerEventId: processed,
          eventType: 'payment_intent.succeeded',
          payload: {},
          receivedAt: daysAgo(2 * DAYS),
          processedAt: daysAgo(2 * DAYS),
        },
      ]);

      const age = await read('payment_inbox_oldest_unprocessed_age_seconds');
      expect(age).toBeGreaterThanOrEqual(DAYS * DAY_SECONDS);
      expect(age).toBeLessThan((DAYS + 1) * DAY_SECONDS);

      await harness.db
        .update(schema.paymentEvents)
        .set({ processedAt: new Date() })
        .where(eq(schema.paymentEvents.providerEventId, unprocessed));

      expect(
        await read('payment_inbox_oldest_unprocessed_age_seconds'),
      ).toBeLessThan(DAYS * DAY_SECONDS);
    });

    it('reads how far the most overdue unpaid order is past its expiry', async () => {
      const order = (status: OrderStatus, expiresAt: Date) => ({
        id: uuidv7(),
        businessDay: '2025-08-01',
        channel: 'COUNTER' as const,
        createdByUserId: cashierId,
        status,
        subtotalMinor: 1000,
        vatMinor: 0,
        totalMinor: 1000,
        currency: 'THB',
        expiresAt,
      });
      const unpaid = order('PENDING_PAYMENT', daysAgo(DAYS));
      await harness.db
        .insert(schema.orders)
        .values([unpaid, order('EXPIRED', daysAgo(2 * DAYS))]);

      const overdue = await read('orders_pending_payment_overdue_seconds');
      expect(overdue).toBeGreaterThanOrEqual(DAYS * DAY_SECONDS);
      expect(overdue).toBeLessThan((DAYS + 1) * DAY_SECONDS);

      await harness.db
        .update(schema.orders)
        .set({ status: 'CANCELLED' })
        .where(eq(schema.orders.id, unpaid.id));

      expect(await read('orders_pending_payment_overdue_seconds')).toBeLessThan(
        DAYS * DAY_SECONDS,
      );
    });

    it("reports each active kiosk's age, and leaves revoked ones out", async () => {
      const active = await harness.createDevice('ACTIVE');
      const revoked = await harness.createDevice('REVOKED');
      await harness.db
        .update(schema.kioskDevices)
        .set({ lastSeenAt: daysAgo(DAYS) })
        .where(inArray(schema.kioskDevices.id, [active.id, revoked.id]));

      const age = await read('kiosk_last_seen_age_seconds', {
        device: active.id,
      });
      expect(age).toBeGreaterThanOrEqual(DAYS * DAY_SECONDS);
      expect(age).toBeLessThan((DAYS + 1) * DAY_SECONDS);
      expect(
        await read('kiosk_last_seen_age_seconds', { device: revoked.id }),
      ).toBeUndefined();
    });

    it('reports the dependencies it can reach as up', async () => {
      expect(await read('dependency_up', { dependency: 'postgres' })).toBe(1);
      expect(await read('dependency_up', { dependency: 'redis' })).toBe(1);
    });

    it('reports whether the cafe is inside its opening hours', async () => {
      const config: ConfigService<Env, true> = harness.app.get(ConfigService);
      const hours = {
        timeZone: config.get('BUSINESS_TIMEZONE', { infer: true }),
        open: config.get('BUSINESS_OPEN_TIME', { infer: true }),
        close: config.get('BUSINESS_CLOSE_TIME', { infer: true }),
      };
      const expected = () => (isOpenAt(new Date(), hours) ? 1 : 0);

      // Computed either side of the scrape, so an opening or closing minute cannot split them.
      const before = expected();
      const reading = await read('business_open');
      expect([before, expected()]).toContain(reading);
    });
  });
```

In `test/redis-outage-http.e2e-spec.ts`, import `Metrics` and `sampleOf` as in Task 1, and add inside the top-level `describe`:

```ts
  describe('the metrics it serves', () => {
    it('reports Redis as down and Postgres as up', async () => {
      const metrics = harness.app.get(Metrics);

      expect(
        await sampleOf(metrics, 'dependency_up', { dependency: 'redis' }),
      ).toBe(0);
      expect(
        await sampleOf(metrics, 'dependency_up', { dependency: 'postgres' }),
      ).toBe(1);
    });
  });
```

Run: `NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 npx jest --config ./test/jest-e2e.json test/metrics.e2e-spec.ts test/redis-outage-http.e2e-spec.ts`
Expected: FAIL, every new reading is `undefined`.

- [ ] **Step 3: Implement the gauges**

Create `src/observability/metrics/state-gauges.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { kioskDevices, orders, paymentEvents } from '../../database/schema';
import { HealthService } from '../../health/health.service';
import { isOpenAt, type OpeningHours } from '../../orders/business-hours';
import { Metrics } from './metrics';

/**
 * Longer than the readiness checks' own 2 s timeouts, which report a
 * dependency as down when they fire. A shorter deadline would turn a dead
 * database into no value instead of 0, and DatabaseDown keys on the 0.
 */
const READINESS_DEADLINE_MS = 3000;

/** The state no event announces, read from its source on every scrape. */
@Injectable()
export class StateGauges {
  constructor(
    metrics: Metrics,
    @Inject(DRIZZLE) db: Database,
    health: HealthService,
    config: ConfigService<Env, true>,
  ) {
    const hours: OpeningHours = {
      timeZone: config.get('BUSINESS_TIMEZONE', { infer: true }),
      open: config.get('BUSINESS_OPEN_TIME', { infer: true }),
      close: config.get('BUSINESS_CLOSE_TIME', { infer: true }),
    };

    metrics.scraped(
      {
        name: 'business_open',
        help: '1 while the cafe is inside its configured opening hours, else 0.',
      },
      () => [{ labels: {}, value: isOpenAt(new Date(), hours) ? 1 : 0 }],
    );

    metrics.scraped(
      {
        name: 'dependency_up',
        help: 'Whether this instance can reach each dependency its readiness probe checks.',
        labelNames: ['dependency'] as const,
        deadlineMs: READINESS_DEADLINE_MS,
      },
      async () => {
        const { checks } = await health.checkReadiness();
        return [
          {
            labels: { dependency: 'postgres' },
            value: checks.db.status === 'up' ? 1 : 0,
          },
          {
            labels: { dependency: 'redis' },
            value: checks.redis.status === 'up' ? 1 : 0,
          },
        ];
      },
    );

    metrics.scraped(
      {
        name: 'orders_pending_payment_overdue_seconds',
        help: 'How far the most overdue unpaid order is past its expiry; 0 when none is.',
      },
      async () => {
        const [row] = await db
          .select({
            seconds: sql<number>`coalesce(max(extract(epoch from now() - ${orders.expiresAt})), 0)::float8`,
          })
          .from(orders)
          .where(
            and(
              eq(orders.status, 'PENDING_PAYMENT'),
              lt(orders.expiresAt, sql`now()`),
            ),
          );
        return [{ labels: {}, value: Number(row.seconds) }];
      },
    );

    metrics.scraped(
      {
        name: 'payment_inbox_oldest_unprocessed_age_seconds',
        help: 'Age of the oldest webhook event not yet processed; 0 when the inbox is drained.',
      },
      async () => {
        const [row] = await db
          .select({
            seconds: sql<number>`coalesce(extract(epoch from now() - min(${paymentEvents.receivedAt})), 0)::float8`,
          })
          .from(paymentEvents)
          .where(isNull(paymentEvents.processedAt));
        return [{ labels: {}, value: Number(row.seconds) }];
      },
    );

    metrics.scraped(
      {
        name: 'kiosk_last_seen_age_seconds',
        help: 'Seconds since each active kiosk was last heard from.',
        labelNames: ['device'] as const,
      },
      async () => {
        const rows = await db
          .select({
            id: kioskDevices.id,
            // A paired kiosk that has never connected has been offline since it was registered.
            seconds: sql<number>`extract(epoch from now() - coalesce(${kioskDevices.lastSeenAt}, ${kioskDevices.createdAt}))::float8`,
          })
          .from(kioskDevices)
          .where(eq(kioskDevices.status, 'ACTIVE'));
        return rows.map((row) => ({
          labels: { device: row.id },
          value: Math.max(0, Number(row.seconds)),
        }));
      },
    );
  }
}
```

Create `src/observability/metrics/state-gauges.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { HealthModule } from '../../health/health.module';
import { StateGauges } from './state-gauges';

// Separate from MetricsModule, which stays dependency-free for the probe-module suite.
@Module({ imports: [HealthModule], providers: [StateGauges] })
export class StateGaugesModule {}
```

In `src/app.module.ts`, import `StateGaugesModule` and add it to `imports` directly after `HealthModule`.

Run the two suites from Step 2.
Expected: PASS.

- [ ] **Step 4: Falsify each filter**

One at a time, restoring after each:
1. Delete `.where(isNull(paymentEvents.processedAt))`. Expected: RED, the inbox reads about 800 days.
2. Delete `eq(orders.status, 'PENDING_PAYMENT'),`. Expected: RED, the overdue gauge reads about 800 days.
3. Delete `.where(eq(kioskDevices.status, 'ACTIVE'))`. Expected: RED, the revoked device appears.
4. Replace the Redis sample's value with a constant `1`. Expected: RED in `redis-outage-http`.

- [ ] **Step 5: Verify and commit**

```bash
git add src/health/health.module.ts src/observability src/app.module.ts test/metrics.e2e-spec.ts test/redis-outage-http.e2e-spec.ts
git commit -m "Read the state no event announces when Prometheus scrapes"
```

---

### Task 5: Count orders and payments once they have committed

Reviewable on one question: does each count move exactly once per fact, after the commit, and never on a replay or a refused write?

**Files:**
- Modify: `src/observability/metrics/metrics.ts`
- Create: `src/observability/metrics/metrics.spec.ts`
- Modify: `src/orders/orders.service.ts`
- Modify: `src/payments/create/create-payment.service.ts`
- Modify: `src/payments/webhooks/payment-event-processor.service.ts`
- Modify: `src/orders/cancel/cancel-order.service.ts`
- Modify: `src/orders/expiry/order-expiry.service.ts`
- Modify: `test/metrics.e2e-spec.ts`
- Modify: `test/create-payment.e2e-spec.ts`
- Modify: `test/expiry-cancels-intent.e2e-spec.ts`
- Modify: `test/payment-inbox.e2e-spec.ts`

**Interfaces:**
- Produces: `Metrics.ordersCreated` (`channel`), `Metrics.payments` (`provider`, `status`), both initialized at zero for every value the app can produce.

- [ ] **Step 1: Write the failing unit test for the zero start**

Create `src/observability/metrics/metrics.spec.ts`:

```ts
import { Metrics } from './metrics';
import { sampleOf } from './sample-of';

// Zero from the first scrape, so `increase()` has a series before the first sale.
describe('Metrics', () => {
  it('exports every order channel at zero before the first order', async () => {
    const metrics = new Metrics();

    expect(
      await sampleOf(metrics, 'orders_created_total', { channel: 'KIOSK' }),
    ).toBe(0);
    expect(
      await sampleOf(metrics, 'orders_created_total', { channel: 'COUNTER' }),
    ).toBe(0);
  });

  it('exports every payment outcome at zero before the first payment', async () => {
    const metrics = new Metrics();

    for (const [provider, status] of [
      ['STRIPE', 'SUCCEEDED'],
      ['STRIPE', 'FAILED'],
      ['STRIPE', 'CANCELLED'],
      ['CASH', 'SUCCEEDED'],
    ]) {
      expect(
        await sampleOf(metrics, 'payments_total', { provider, status }),
      ).toBe(0);
    }
  });
});
```

Run: `pnpm test -- src/observability/metrics/metrics.spec.ts`
Expected: FAIL, both read `undefined`.

- [ ] **Step 2: Add the counters**

In `src/observability/metrics/metrics.ts`, import `orderChannels` from `../../database/schema/enums`, add above the class:

```ts
/** Every (provider, status) the app can end a payment in. Cash is born SUCCEEDED. */
const TERMINAL_PAYMENTS = [
  ['STRIPE', 'SUCCEEDED'],
  ['STRIPE', 'FAILED'],
  ['STRIPE', 'CANCELLED'],
  ['CASH', 'SUCCEEDED'],
] as const;
```

and add after `httpRequestDuration`:

```ts
  readonly ordersCreated = new Counter({
    name: 'orders_created_total',
    help: 'Orders committed, by channel. An idempotent replay is not a new order.',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  readonly payments = new Counter({
    name: 'payments_total',
    help: 'Payments reaching a terminal status, counted once the guarded write has landed.',
    labelNames: ['provider', 'status'] as const,
    registers: [this.registry],
  });

  constructor() {
    for (const channel of orderChannels) {
      this.ordersCreated.inc({ channel }, 0);
    }
    for (const [provider, status] of TERMINAL_PAYMENTS) {
      this.payments.inc({ provider, status }, 0);
    }
  }
```

Run: `pnpm test -- src/observability/metrics/metrics.spec.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing e2e tests**

In `test/metrics.e2e-spec.ts`, add inside the top-level `describe`:

```ts
  describe('orders', () => {
    let kioskToken: string;
    let croissantId: string;
    const categoryIds: string[] = [];
    const itemIds: string[] = [];
    const keys: string[] = [];

    beforeAll(async () => {
      const adminToken = await harness.tokenFor('ADMIN');
      const post = async (path: string, body: object): Promise<string> => {
        const res = await harness
          .http()
          .post(path)
          .set('Authorization', `Bearer ${adminToken}`)
          .send(body);
        if (res.status !== 201) {
          throw new Error(`fixture ${path} failed with ${res.status}`);
        }
        return (res.body as { id: string }).id;
      };

      const categoryId = await post('/api/v1/categories', {
        name: `Metrics pastries ${uuidv7()}`,
        sortOrder: 0,
      });
      categoryIds.push(categoryId);
      croissantId = await post('/api/v1/items', {
        categoryId,
        name: `Metrics croissant ${uuidv7()}`,
        basePriceMinor: 2000,
        sortOrder: 0,
      });
      itemIds.push(croissantId);
      kioskToken = (await harness.createDevice('ACTIVE')).token;
    });

    afterAll(async () => {
      await harness.purgeOrders();
      if (keys.length > 0) {
        await harness.db
          .delete(schema.idempotencyKeys)
          .where(inArray(schema.idempotencyKeys.key, keys));
      }
      if (itemIds.length > 0) {
        await harness.db
          .delete(schema.menuItems)
          .where(inArray(schema.menuItems.id, itemIds));
      }
      if (categoryIds.length > 0) {
        await harness.db
          .delete(schema.categories)
          .where(inArray(schema.categories.id, categoryIds));
      }
    });

    const placeOrder = (key: string, extra: object = {}) => {
      keys.push(key);
      return harness
        .http()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${kioskToken}`)
        .set('Idempotency-Key', key)
        .send({
          channel: 'KIOSK',
          items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
          ...extra,
        });
    };

    const kioskOrders = async () =>
      (await sampleOf(harness.app.get(Metrics), 'orders_created_total', {
        channel: 'KIOSK',
      })) ?? 0;

    it('counts an order once, however many times the kiosk retries it', async () => {
      const before = await kioskOrders();
      const key = `metrics-${uuidv7()}`;

      const first = await placeOrder(key);
      const retry = await placeOrder(key);

      expect(first.status).toBe(201);
      expect(retry.headers['idempotency-replayed']).toBe('true');
      expect(await kioskOrders()).toBe(before + 1);
    });

    it('does not count an order it refused', async () => {
      const before = await kioskOrders();

      const res = await placeOrder(`metrics-${uuidv7()}`, {
        expectedTotalMinor: 1,
      });

      expect(res.status).toBe(409);
      expect(await kioskOrders()).toBe(before);
    });
  });
```

In `test/create-payment.e2e-spec.ts`, import `Metrics` and `sampleOf`, add inside the top-level `describe`:

```ts
  const cashPayments = async () =>
    (await sampleOf(harness.app.get(Metrics), 'payments_total', {
      provider: 'CASH',
      status: 'SUCCEEDED',
    })) ?? 0;
```

In `'settles immediately and pays the order'`, record `const before = await cashPayments();` before `pay(...)`, and add at the end:

```ts
      expect(await cashPayments()).toBe(before + 1);
```

In `'replays a repeated Idempotency-Key instead of paying twice'`, record `const before = await cashPayments();` before the first request, and add at the end:

```ts
    // The replay hands back the payment the first request already counted.
    expect(await cashPayments()).toBe(before + 1);
```

In `test/expiry-cancels-intent.e2e-spec.ts`, import `Metrics` and `sampleOf`, add inside the top-level `describe`:

```ts
  const cancelledPayments = async () =>
    (await sampleOf(harness.app.get(Metrics), 'payments_total', {
      provider: 'STRIPE',
      status: 'CANCELLED',
    })) ?? 0;
```

Then:
- In `'cancels the intent behind an order it reclaims'`: `const before = await cancelledPayments();` first, and `expect(await cancelledPayments()).toBe(before + 1);` last.
- In `'leaves an order alone when its payment already succeeded'`: the same pair, expecting `before`.
- In `'cancels the intent behind the order it is cancelling'`: the same pair, expecting `before + 1`.
- In `'refuses to cancel when the gateway cannot be reached'`: the same pair, expecting `before`.

In `test/payment-inbox.e2e-spec.ts`, import `Metrics` and `sampleOf`, add inside the top-level `describe`:

```ts
  const stripePayments = async (status: 'SUCCEEDED' | 'FAILED') =>
    (await sampleOf(harness.app.get(Metrics), 'payments_total', {
      provider: 'STRIPE',
      status,
    })) ?? 0;

  /** A declined card, as Stripe sends it. */
  async function givenFailureEvent(intentId: string): Promise<string> {
    const providerEventId = `evt_e2e_${uuidv7()}`;
    eventIds.push(providerEventId);

    const [row] = await harness.db
      .insert(schema.paymentEvents)
      .values({
        providerEventId,
        eventType: 'payment_intent.payment_failed',
        payload: {
          id: providerEventId,
          object: 'event',
          type: 'payment_intent.payment_failed',
          api_version: '2026-07-29.dahlia',
          created: 1_785_829_150,
          data: { object: { id: intentId, last_payment_error: null } },
        },
      })
      .returning({ id: schema.paymentEvents.id });

    return row.id;
  }
```

In `'changes nothing when the same row is processed again'`, record `const before = await stripePayments('SUCCEEDED');` first, and add at the end:

```ts
    expect(await stripePayments('SUCCEEDED')).toBe(before + 1);
```

Add these tests:

```ts
  // Rules out counting every processed event: the second is decided SKIP and writes nothing.
  it('counts nothing for a success it has already applied', async () => {
    const { intentId } = await givenOrderAwaitingPayment();
    await processor.processEvent(await givenInboxEvent(intentId));
    const before = await stripePayments('SUCCEEDED');

    await processor.processEvent(await givenInboxEvent(intentId));

    expect(await stripePayments('SUCCEEDED')).toBe(before);
  });

  it('counts a declined payment once', async () => {
    const { paymentId, intentId } = await givenOrderAwaitingPayment();
    const rowId = await givenFailureEvent(intentId);
    const before = await stripePayments('FAILED');

    await processor.processEvent(rowId);
    await processor.processEvent(rowId);

    expect((await paymentRow(paymentId))?.status).toBe('FAILED');
    expect(await stripePayments('FAILED')).toBe(before + 1);
  });

  // A refused event changed nothing, so it is not a payment outcome.
  it('counts nothing for an event it refused', async () => {
    const { intentId } = await givenOrderAwaitingPayment();
    const before = await stripePayments('SUCCEEDED');

    await processor.processEvent(await givenInboxEvent(intentId, 1));

    expect(await stripePayments('SUCCEEDED')).toBe(before);
  });
```

Run: `NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 npx jest --config ./test/jest-e2e.json test/metrics.e2e-spec.ts test/create-payment.e2e-spec.ts test/expiry-cancels-intent.e2e-spec.ts test/payment-inbox.e2e-spec.ts`
Expected: FAIL on every `before + 1`.

- [ ] **Step 4: Count orders**

In `src/orders/orders.service.ts`, import `Metrics` from `../observability/metrics/metrics`, add `private readonly metrics: Metrics,` as the last constructor parameter, and in `create` change the success path to:

```ts
      const order = await this.db.transaction(async (tx) => {
        // ...unchanged...
      });

      // Committed by now. The replay branch below returns an order counted when it was made.
      this.metrics.ordersCreated.inc({ channel: order.channel });
      return { order, replayed: false };
```

- [ ] **Step 5: Count cash**

In `src/payments/create/create-payment.service.ts`, add `private readonly metrics: Metrics,` as the last constructor parameter. In `takeCash`, replace `return this.write(idempotencyKey, requestHash, async (tx, emit) => {` with `const result = await this.write(idempotencyKey, requestHash, async (tx, emit) => {`, leave the callback body unchanged, and after its closing `});` add:

```ts
    // A replay hands back the payment the first request already counted.
    if (!result.replayed) {
      this.metrics.payments.inc({ provider: 'CASH', status: 'SUCCEEDED' });
    }
    return result;
```

- [ ] **Step 6: Count webhook outcomes**

In `src/payments/webhooks/payment-event-processor.service.ts`, add `private readonly metrics: Metrics,` as the last constructor parameter.

Replace the `MARK_PAYMENT` case with:

```ts
      case 'MARK_PAYMENT': {
        const landed = await this.afterCommit.run(async (tx, emit) => {
          // ...the existing body, unchanged, then as its last statement:
          return settled !== undefined;
        });

        // The guard refusing a stale decision changed nothing, so there is nothing to count.
        if (landed) {
          this.metrics.payments.inc({
            provider: 'STRIPE',
            status: decision.status,
          });
        }
        return true;
      }
```

In `markPaid`, directly before `return true;`:

```ts
    this.metrics.payments.inc({ provider: 'STRIPE', status: 'SUCCEEDED' });
```

- [ ] **Step 7: Count cancelled intents**

In `src/orders/cancel/cancel-order.service.ts`, add `private readonly metrics: Metrics,` as the last constructor parameter. Replace `return this.afterCommit.run(async (tx, emit) => {` with:

```ts
    let cancelledPayment = false;
    const summary = await this.afterCommit.run(async (tx, emit) => {
```

Inside, change the payment update to report whether it matched:

```ts
      if (live !== undefined) {
        const [cancelled] = await tx
          .update(payments)
          .set({ status: 'CANCELLED' })
          .where(
            and(
              eq(payments.id, live.id),
              notInArray(payments.status, ['SUCCEEDED']),
            ),
          )
          .returning({ id: payments.id });
        cancelledPayment = cancelled !== undefined;
      }
```

and after the callback's closing `});`:

```ts
    if (cancelledPayment) {
      this.metrics.payments.inc({ provider: 'STRIPE', status: 'CANCELLED' });
    }
    return summary;
```

In `src/orders/expiry/order-expiry.service.ts`, add `private readonly metrics: Metrics,` as the last constructor parameter, and in `expireOne` directly after the `await this.db.transaction(...)` block and before `return true;`:

```ts
      if (live !== undefined) {
        this.metrics.payments.inc({ provider: 'STRIPE', status: 'CANCELLED' });
      }
```

Run the four suites from Step 3.
Expected: PASS.

- [ ] **Step 8: Falsify**

One at a time, restoring after each:
1. Move the `ordersCreated.inc` to before `const order = await this.db.transaction(`. Expected: RED on "does not count an order it refused".
2. Move it to the top of `create`, above the `try`. Expected: RED on "counts an order once, however many times the kiosk retries it".
3. Drop the `if (landed)` guard. Expected: still green, and that is expected, because no deterministic test reaches the stale-decision branch. Record this in the task's review notes as the one unfalsified increment, guarded by construction rather than by a test.
4. Move the `SUCCEEDED` increment out of `markPaid` to the top of `apply`, before the decision switch. Expected: RED on "counts nothing for a success it has already applied" and "counts nothing for an event it refused".
5. In `takeCash`, drop `if (!result.replayed)`. Expected: RED on the cash replay test.

- [ ] **Step 9: Verify and commit**

```bash
git add src test
git commit -m "Count orders and payments once they have committed"
```

---

### Task 6: Watch the webhook path

The two webhook signals: how late events arrive, and processing that throws. Reviewable on one question: is a lost race kept out of the failure count, and is only a first delivery timed?

**Files:**
- Modify: `src/observability/metrics/metrics.ts`
- Modify: `src/payments/provider/payment-provider.ts`
- Modify: `src/payments/provider/stripe-payment.provider.ts`
- Modify: `src/payments/provider/stripe-payment.provider.spec.ts`
- Modify: `src/payments/webhooks/stripe-webhook.controller.ts`
- Modify: `src/payments/webhooks/stripe-webhook.controller.spec.ts`
- Modify: `src/orders/state/transition-order.ts`
- Modify: `src/orders/expiry/order-expiry.service.ts`
- Modify: `src/orders/expiry/order-expiry.spec.ts`
- Modify: `src/payments/webhooks/payment-event-processor.service.ts`
- Create: `src/payments/webhooks/payment-event-processor.spec.ts`
- Modify: `test/stripe-webhook.e2e-spec.ts`

**Interfaces:**
- Produces: `GatewayEvent.createdAt: Date`; `Metrics.webhookLag`, `Metrics.webhookProcessingFailures`; `isLostRace` now exported from `src/orders/state/transition-order.ts`.

- [ ] **Step 1: Add the instruments**

In `src/observability/metrics/metrics.ts`, add after `payments`:

```ts
  readonly webhookProcessingFailures = new Counter({
    name: 'webhook_processing_failures_total',
    help: 'Inbox events whose processing threw, excluding a lost race with another instance.',
    registers: [this.registry],
  });

  readonly webhookLag = new Histogram({
    name: 'webhook_lag_seconds',
    help: 'Time from the gateway creating an event to this system first storing it.',
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900, 3600],
    registers: [this.registry],
  });
```

- [ ] **Step 2: Carry the gateway's timestamp, test first**

In `src/payments/provider/stripe-payment.provider.spec.ts`, inside `describe('parseWebhook signature verification')`:

```ts
    it('carries the time the gateway created the event', () => {
      const body = eventBody('payment_intent.canceled', { id: 'pi_1' });

      const event = providerWith([NEW_SECRET]).parseWebhook(
        Buffer.from(body),
        sign(body, NEW_SECRET),
      );

      expect(event.createdAt).toEqual(new Date(1_785_829_150 * 1000));
    });
```

Run: `pnpm test -- src/payments/provider/stripe-payment.provider.spec.ts`
Expected: FAIL, `createdAt` is undefined.

In `src/payments/provider/payment-provider.ts`, add to `GatewayEvent` after `type`:

```ts
  /** When the gateway created the event: where `webhook_lag_seconds` starts. */
  createdAt: Date;
```

In `src/payments/provider/stripe-payment.provider.ts`, in `parseWebhook`'s returned object, after `type: event.type,`:

```ts
      createdAt: new Date(event.created * 1000),
```

Run the provider spec. Expected: PASS.

- [ ] **Step 3: Time first deliveries, test first**

In `src/payments/webhooks/stripe-webhook.controller.spec.ts`, import `Metrics` from `../../observability/metrics/metrics` and `sampleOf` from `../../observability/metrics/sample-of`. Change `controllerWith` to:

```ts
function controllerWith(
  inbox: RecordingInbox,
  processor: RecordingProcessor = new RecordingProcessor(),
  metrics: Metrics = new Metrics(),
): StripeWebhookController {
  return new StripeWebhookController(
    new StripePaymentProvider(stripe, [SECRET]),
    inbox as unknown as WebhookInboxService,
    processor as unknown as PaymentEventProcessor,
    metrics,
  );
}
```

and add:

```ts
  describe('webhook lag', () => {
    const lagCount = (metrics: Metrics) =>
      sampleOf(metrics, 'webhook_lag_seconds_count');

    it('times an event the first time it is stored', async () => {
      const metrics = new Metrics();
      const body = eventBody();

      await controllerWith(new RecordingInbox(), undefined, metrics).receive(
        requestWith(Buffer.from(body)),
        sign(body),
      );

      expect(await lagCount(metrics)).toBe(1);
      // created is 2026-07-31, so the observed lag is at least the weeks since.
      expect(await sampleOf(metrics, 'webhook_lag_seconds_sum')).toBeGreaterThan(
        Date.now() / 1000 - 1_785_829_150 - 60,
      );
    });

    // A redelivery is Stripe retrying an event we already hold; its age says nothing about us.
    it('does not time a redelivery', async () => {
      const metrics = new Metrics();
      const body = eventBody();

      await controllerWith(new RecordingInbox(null), undefined, metrics).receive(
        requestWith(Buffer.from(body)),
        sign(body),
      );

      expect(await lagCount(metrics)).toBe(0);
    });
  });
```

Run: `pnpm test -- src/payments/webhooks/stripe-webhook.controller.spec.ts`
Expected: FAIL to compile, the controller takes three arguments.

In `src/payments/webhooks/stripe-webhook.controller.ts`, import `Metrics`, add `private readonly metrics: Metrics,` as the last constructor parameter, and replace the kick with:

```ts
    if (eventRowId !== null) {
      this.metrics.webhookLag.observe(
        Math.max(0, (Date.now() - event.createdAt.getTime()) / 1000),
      );
      void this.processor.processEvent(eventRowId);
    }
```

Run the controller spec. Expected: PASS.

- [ ] **Step 4: Move `isLostRace` beside the transition it describes**

In `src/orders/state/transition-order.ts`, add at the end of the file:

```ts
/**
 * Whether a transition failed because something else moved the order first:
 * it is no longer in `from`, or it is gone. Both are the guard doing its job,
 * not a fault.
 */
export const isLostRace = (error: unknown): boolean =>
  error instanceof OrderInvalidTransitionError ||
  error instanceof ResourceNotFoundError;
```

In `src/orders/expiry/order-expiry.service.ts`, delete the `isLostRace` declaration and its comment, delete the now-unused `ResourceNotFoundError` and `OrderInvalidTransitionError` imports, and import `isLostRace` alongside `transitionOrder`: `import { isLostRace, transitionOrder } from '../state/transition-order';`.

In `src/orders/expiry/order-expiry.spec.ts`, change the import to `import { isLostRace } from '../state/transition-order';`.

Run: `pnpm test -- src/orders/expiry/order-expiry.spec.ts`
Expected: PASS, unchanged.

- [ ] **Step 5: Count processing failures, test first**

Create `src/payments/webhooks/payment-event-processor.spec.ts`:

```ts
import type { Database } from '../../database/database.module';
import { Metrics } from '../../observability/metrics/metrics';
import { sampleOf } from '../../observability/metrics/sample-of';
import { OrderInvalidTransitionError } from '../../orders/errors/orders.errors';
import type { AfterCommit } from '../../realtime/events/after-commit.service';
import type { PaymentProvider } from '../provider/payment-provider';
import { PaymentEventProcessor } from './payment-event-processor.service';

/** A database whose every read fails with `error`. */
const databaseFailingWith = (error: Error) =>
  ({
    query: { paymentEvents: { findFirst: () => Promise.reject(error) } },
    select: () => {
      throw error;
    },
  }) as unknown as Database;

const processorWith = (error: Error, metrics: Metrics) =>
  new PaymentEventProcessor(
    databaseFailingWith(error),
    {} as PaymentProvider,
    {} as AfterCommit,
    metrics,
  );

const failures = (metrics: Metrics) =>
  sampleOf(metrics, 'webhook_processing_failures_total');

describe('PaymentEventProcessor failure counting', () => {
  it('counts an event whose processing threw', async () => {
    const metrics = new Metrics();

    await expect(
      processorWith(new Error('connection reset'), metrics).processEvent('e1'),
    ).resolves.toBe(false);

    expect(await failures(metrics)).toBe(1);
  });

  /**
   * The other instance applied the event between our read and our write, so
   * the guarded transition refused ours. The system worked; counting it would
   * page someone for that.
   */
  it('does not count a lost race', async () => {
    const metrics = new Metrics();

    await processorWith(
      new OrderInvalidTransitionError('PAID', 'PAID'),
      metrics,
    ).processEvent('e1');

    expect(await failures(metrics)).toBe(0);
  });

  it('counts a sweep that could not read the inbox', async () => {
    const metrics = new Metrics();

    await processorWith(new Error('connection reset'), metrics).drainInbox();

    expect(await failures(metrics)).toBe(1);
  });
});
```

Run: `pnpm test -- src/payments/webhooks/payment-event-processor.spec.ts`
Expected: FAIL on the two counting tests.

In `src/payments/webhooks/payment-event-processor.service.ts`, import `isLostRace` from `../../orders/state/transition-order`. Replace `processEvent`'s `catch` with:

```ts
    } catch (error) {
      /**
       * Two instances can apply the same event at once; the second's guarded
       * transition then throws. The transaction rolled back and the next sweep
       * re-reads the row, where the inbox gauge notices if it never settles.
       */
      if (isLostRace(error)) {
        this.logger.debug(
          `Payment event ${eventId} was applied elsewhere first. ${describeError(error)}`,
        );
        return false;
      }

      this.metrics.webhookProcessingFailures.inc();
      this.logger.error(
        `Failed to process payment event ${eventId}; leaving it for the sweep. ${describeError(error)}`,
      );
      return false;
    }
```

In `drainInbox`'s `catch`, add `this.metrics.webhookProcessingFailures.inc();` before the existing `this.logger.error(...)`.

Run the processor spec. Expected: PASS.

- [ ] **Step 6: One e2e check through the real route**

In `test/stripe-webhook.e2e-spec.ts`, import `Metrics` and `sampleOf`, and add:

```ts
  it('times the first delivery of an event and not its redelivery', async () => {
    const metrics = harness.app.get(Metrics);
    const lagCount = async () =>
      (await sampleOf(metrics, 'webhook_lag_seconds_count')) ?? 0;
    const body = eventBody(nextEventId());
    const before = await lagCount();

    await post(body, sign(body));
    await post(body, sign(body));

    expect(await lagCount()).toBe(before + 1);
  });
```

Run: `NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 npx jest --config ./test/jest-e2e.json test/stripe-webhook.e2e-spec.ts test/payment-inbox.e2e-spec.ts test/crash-recovery.e2e-spec.ts test/expiry-cancels-intent.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 7: Falsify**

1. Delete the `isLostRace` branch in `processEvent`. Expected: RED on "does not count a lost race".
2. Move the lag observation above `if (eventRowId !== null)`. Expected: RED on "does not time a redelivery" and on the e2e test.

- [ ] **Step 8: Verify and commit**

```bash
git add src test
git commit -m "Watch how late webhooks arrive and when processing them fails"
```

---

### Task 7: Publish what reconciliation found, and which screens are connected

Two in-memory gauges. Reviewable on one question: is the reconciliation delta written only by the nightly job, and cleared when that job could not check?

**Files:**
- Modify: `src/observability/metrics/metrics.ts`
- Modify: `src/observability/metrics/metrics.spec.ts`
- Modify: `src/payments/reconciliation/reconciliation.service.ts`
- Modify: `src/realtime/kds.gateway.ts`
- Modify: `src/realtime/kiosk.gateway.ts`
- Modify: `src/realtime/board.gateway.ts`
- Modify: `test/reconciliation.e2e-spec.ts`
- Modify: `test/metrics.e2e-spec.ts`

**Interfaces:**
- Produces: `Metrics.reconciliationRuns`, `recordReconciliation(deltaMinor)`, `recordReconciliationFailure()`, `trackNamespace(name, server)`, `SocketNamespace`; gauges `reconciliation_delta_minor` and `ws_connected{namespace}`.

- [ ] **Step 1: Write the failing unit tests**

In `src/observability/metrics/metrics.spec.ts`, import `type { Namespace } from 'socket.io'` and add:

```ts
  describe('reconciliation', () => {
    it('exports no delta until a run has checked', async () => {
      expect(
        await sampleOf(new Metrics(), 'reconciliation_delta_minor'),
      ).toBeUndefined();
    });

    it('publishes the delta a run found, and counts the run by outcome', async () => {
      const metrics = new Metrics();

      metrics.recordReconciliation(-500);

      expect(await sampleOf(metrics, 'reconciliation_delta_minor')).toBe(-500);
      expect(
        await sampleOf(metrics, 'reconciliation_runs_total', {
          outcome: 'delta',
        }),
      ).toBe(1);
    });

    // "Could not check" must not leave "checked and it agrees" standing.
    it('clears the delta when a run could not check', async () => {
      const metrics = new Metrics();
      metrics.recordReconciliation(0);

      metrics.recordReconciliationFailure();

      expect(
        await sampleOf(metrics, 'reconciliation_delta_minor'),
      ).toBeUndefined();
      expect(
        await sampleOf(metrics, 'reconciliation_runs_total', {
          outcome: 'failed',
        }),
      ).toBe(1);
    });
  });

  it('reports the sockets each tracked namespace holds', async () => {
    const metrics = new Metrics();
    const kds = {
      sockets: new Map([
        ['a', {}],
        ['b', {}],
      ]),
    } as unknown as Namespace;

    metrics.trackNamespace('kds', kds);

    expect(await sampleOf(metrics, 'ws_connected', { namespace: 'kds' })).toBe(
      2,
    );
  });
```

Run: `pnpm test -- src/observability/metrics/metrics.spec.ts`
Expected: FAIL to compile.

- [ ] **Step 2: Implement them**

In `src/observability/metrics/metrics.ts`, import `type { Namespace } from 'socket.io'`, export the namespace type above the class:

```ts
export type SocketNamespace = 'kds' | 'kiosk' | 'board';
```

add fields after `webhookLag`:

```ts
  readonly reconciliationRuns = new Counter({
    name: 'reconciliation_runs_total',
    help: 'Nightly reconciliation runs, by what they found.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  private reconciliationDelta: number | null = null;
  private readonly namespaces = new Map<SocketNamespace, Namespace>();
```

add to the end of the constructor:

```ts
    for (const outcome of ['agreed', 'delta', 'failed'] as const) {
      this.reconciliationRuns.inc({ outcome }, 0);
    }

    this.scraped(
      {
        name: 'reconciliation_delta_minor',
        help: 'Gateway minus books for the day the last nightly run checked, in minor units. Absent until a run has checked.',
      },
      () =>
        this.reconciliationDelta === null
          ? []
          : [{ labels: {}, value: this.reconciliationDelta }],
    );

    this.scraped(
      {
        name: 'ws_connected',
        help: 'Sockets this instance holds, by namespace.',
        labelNames: ['namespace'] as const,
      },
      () =>
        [...this.namespaces].map(([namespace, server]) => ({
          labels: { namespace },
          value: server.sockets.size,
        })),
    );
```

and add methods after `scraped`:

```ts
  trackNamespace(name: SocketNamespace, server: Namespace): void {
    this.namespaces.set(name, server);
  }

  recordReconciliation(deltaMinor: number): void {
    this.reconciliationDelta = deltaMinor;
    this.reconciliationRuns.inc({
      outcome: deltaMinor === 0 ? 'agreed' : 'delta',
    });
  }

  recordReconciliationFailure(): void {
    this.reconciliationDelta = null;
    this.reconciliationRuns.inc({ outcome: 'failed' });
  }
```

Run the spec. Expected: PASS.

- [ ] **Step 3: Wire the producers**

In `src/payments/reconciliation/reconciliation.service.ts`, add `private readonly metrics: Metrics,` as the last constructor parameter. In `reconcileYesterday`, directly after `const report = await this.reconcile(day);` add `this.metrics.recordReconciliation(report.deltaMinor);`, and at the top of the `catch` add `this.metrics.recordReconciliationFailure();`. `reconcile()` itself stays untouched, which is what keeps the Z-report from writing the gauge.

In `src/realtime/kds.gateway.ts` and `src/realtime/kiosk.gateway.ts`, add `private readonly metrics: Metrics,` as the last constructor parameter and make the first line of `afterInit(server)` `this.metrics.trackNamespace('kds', server);` (and `'kiosk'` in the kiosk gateway).

Replace `src/realtime/board.gateway.ts`'s class with:

```ts
@WebSocketGateway({ namespace: NAMESPACES.board })
export class BoardGateway implements OnGatewayInit {
  @WebSocketServer() private readonly server!: Namespace;

  constructor(private readonly metrics: Metrics) {}

  afterInit(server: Namespace): void {
    this.metrics.trackNamespace('board', server);
  }

  broadcast(entries: unknown): void {
    this.server.emit('board.updated', entries);
  }
}
```

keeping the existing doc comment above the class, and adding `OnGatewayInit` to the `@nestjs/websockets` import and `Metrics` to the imports.

- [ ] **Step 4: Write the e2e tests**

In `test/reconciliation.e2e-spec.ts`, import `ConfigService`, `type Env`, `businessDayOf` from `../src/orders/business-day`, `Metrics` and `sampleOf`, and add:

```ts
  describe("the nightly job's metrics", () => {
    const read = (name: string, labels?: Record<string, string>) =>
      sampleOf(harness.app.get(Metrics), name, labels);

    // The same clock and settings `reconcileYesterday` uses.
    const yesterday = (): string => {
      const config: ConfigService<Env, true> = harness.app.get(ConfigService);
      return businessDayOf(
        new Date(Date.now() - 24 * 60 * 60 * 1000),
        config.get('BUSINESS_TIMEZONE', { infer: true }),
        config.get('BUSINESS_DAY_START_HOUR', { infer: true }),
      );
    };

    it('publishes the delta it found, and counts the run', async () => {
      // Every other contribution is at most zero, so ours makes the total strictly negative.
      await givenStripePayment({
        businessDay: yesterday(),
        amountMinor: 10_000,
        gatewaySays: 9_000,
      });
      const before = (await read('reconciliation_runs_total', { outcome: 'delta' })) ?? 0;

      const report = await reconciliation.reconcileYesterday();

      expect(report?.deltaMinor).toBeLessThan(0);
      expect(await read('reconciliation_delta_minor')).toBe(report?.deltaMinor);
      expect(
        await read('reconciliation_runs_total', { outcome: 'delta' }),
      ).toBe(before + 1);
    });

    it('leaves the delta alone when a day is reconciled on demand, as the Z-report does', async () => {
      await reconciliation.reconcileYesterday();
      const published = await read('reconciliation_delta_minor');
      await givenStripePayment({ amountMinor: 10_000, gatewaySays: 1_000 });

      await reconciliation.reconcile(day);

      expect(await read('reconciliation_delta_minor')).toBe(published);
    });

    it('clears the delta and counts a failure when it could not check', async () => {
      await reconciliation.reconcileYesterday();
      gatewayReachable = false;
      const before = (await read('reconciliation_runs_total', { outcome: 'failed' })) ?? 0;

      await reconciliation.reconcileYesterday();

      expect(await read('reconciliation_delta_minor')).toBeUndefined();
      expect(
        await read('reconciliation_runs_total', { outcome: 'failed' }),
      ).toBe(before + 1);
    });
  });
```

In `test/metrics.e2e-spec.ts`, add imports `import { io } from 'socket.io-client';` and `import { NAMESPACES } from '../src/realtime/realtime.constants';`, add this helper above the top-level `describe`:

```ts
async function eventually(
  assertion: () => Promise<void>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
```

and add inside the top-level `describe`:

```ts
  describe('connected screens', () => {
    const connected = (namespace: string) =>
      sampleOf(harness.app.get(Metrics), 'ws_connected', { namespace });

    // Present at zero, not absent: KitchenBlind's sum() over nothing would never fire.
    it('exports every namespace, even with nothing connected', async () => {
      expect(await connected('kds')).toBe(0);
      expect(await connected('kiosk')).toBe(0);
      expect(await connected('board')).toBe(0);
    });

    it('counts a kitchen screen while it is connected', async () => {
      const socket = io(`${harness.url()}${NAMESPACES.kds}`, {
        transports: ['websocket'],
        reconnection: false,
        auth: { token: await harness.tokenFor('BARISTA') },
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });

      expect(await connected('kds')).toBe(1);

      socket.disconnect();
      await eventually(async () => {
        expect(await connected('kds')).toBe(0);
      });
    });
  });
```

Run: `NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 npx jest --config ./test/jest-e2e.json test/reconciliation.e2e-spec.ts test/metrics.e2e-spec.ts test/kds-gateway.e2e-spec.ts test/kiosk-gateway.e2e-spec.ts test/board-http.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 5: Falsify**

1. Move `recordReconciliation` from `reconcileYesterday` into `reconcile`. Expected: RED on "leaves the delta alone when a day is reconciled on demand".
2. Delete `this.reconciliationDelta = null;` from `recordReconciliationFailure`. Expected: RED on "clears the delta" in both the unit and the e2e suite.
3. Delete the `trackNamespace` call from `BoardGateway`. Expected: RED on "exports every namespace".

- [ ] **Step 6: Verify and commit**

```bash
git add src test
git commit -m "Publish what reconciliation found and which screens are connected"
```

---

### Task 8: Count rate-limit refusals

§16's "rate limits live and observed in metrics". Reviewable on one question: is each refusal filed under the rule that refused it?

**Files:**
- Modify: `src/identity/rate-limit/rate-limits.ts`
- Modify: `src/identity/auth/auth.controller.ts`
- Modify: `src/identity/devices/devices.controller.ts`
- Modify: `src/identity/rate-limit/identity-throttler.guard.ts`
- Modify: `src/identity/rate-limit/login-attempt.limiter.ts`
- Modify: `src/observability/metrics/metrics.ts`
- Modify: `test/login-attempt-limiter.e2e-spec.ts`
- Modify: `test/auth-service.e2e-spec.ts`
- Modify: `test/rate-limit-http.e2e-spec.ts`
- Modify: `test/redis-outage-http.e2e-spec.ts`

**Interfaces:**
- Produces: `@RateLimit(name: RateLimitRuleName)`, `RATE_LIMIT_RULE`, `LOCKOUT_RULE`, `RATE_LIMIT_RULE_LABELS`; `Metrics.rateLimitRejections` (`rule`), `Metrics.rateLimitBackendUnavailable` (`policy`).

- [ ] **Step 1: Name the rule on the decorator**

In `src/identity/rate-limit/rate-limits.ts`, add after `RATE_LIMIT_BACKEND_POLICY`:

```ts
export const RATE_LIMIT_RULE = 'rate-limit:rule';
```

add after `RATE_LIMITS`:

```ts
export type RateLimitRuleName = keyof typeof RATE_LIMITS;

/** The per-account half of login limiting, enforced by `LoginAttemptLimiter` outside the throttler. */
export const LOCKOUT_RULE = 'loginAccount';

export const RATE_LIMIT_RULE_LABELS: readonly string[] = [
  ...(Object.keys(RATE_LIMITS) as RateLimitRuleName[]),
  LOCKOUT_RULE,
];
```

and replace `RateLimit` with:

```ts
export const RateLimit = (name: RateLimitRuleName) => {
  const rule: RateLimitRule = RATE_LIMITS[name];
  return applyDecorators(
    Throttle({ default: rule }),
    SetMetadata(RATE_LIMIT_BACKEND_POLICY, rule.onBackendFailure),
    SetMetadata(RATE_LIMIT_RULE, name),
  );
};
```

keeping its doc comment and adding one line to it: `Takes the rule's name so the guard can file a refusal under it.`

Change the two call sites to `@RateLimit('login')` and `@RateLimit('deviceActivation')`, and drop `RATE_LIMITS` from each controller's import if it is now unused.

- [ ] **Step 2: Add the counters**

In `src/observability/metrics/metrics.ts`, import `RATE_LIMIT_RULE_LABELS` from `../../identity/rate-limit/rate-limits`, add after `reconciliationRuns`:

```ts
  readonly rateLimitRejections = new Counter({
    name: 'rate_limit_rejections_total',
    help: 'Requests refused for exceeding a rate limit, by rule. loginAccount is the per-account lockout.',
    labelNames: ['rule'] as const,
    registers: [this.registry],
  });

  readonly rateLimitBackendUnavailable = new Counter({
    name: 'rate_limit_backend_unavailable_total',
    help: 'Requests met while the rate limiter was unreachable, by the outage policy applied.',
    labelNames: ['policy'] as const,
    registers: [this.registry],
  });
```

and to the constructor:

```ts
    for (const rule of RATE_LIMIT_RULE_LABELS) {
      this.rateLimitRejections.inc({ rule }, 0);
    }
    for (const policy of ['allow', 'refuse'] as const) {
      this.rateLimitBackendUnavailable.inc({ policy }, 0);
    }
```

- [ ] **Step 3: Write the failing tests**

In `test/login-attempt-limiter.e2e-spec.ts`, import `Metrics` and `sampleOf`, declare `let metrics: Metrics;`, construct with `metrics = new Metrics(); limiter = new LoginAttemptLimiter(redis, metrics);`, and add:

```ts
  it('counts each attempt it refuses, and none it allows', async () => {
    const lockouts = async () =>
      (await sampleOf(metrics, 'rate_limit_rejections_total', {
        rule: 'loginAccount',
      })) ?? 0;
    const email = freshEmail();
    await failTimes(email, FAILURES_ALLOWED - 1);
    const before = await lockouts();

    await limiter.assertNotLockedOut(email);
    expect(await lockouts()).toBe(before);

    await limiter.recordFailure(email);
    await expect(limiter.assertNotLockedOut(email)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(await lockouts()).toBe(before + 1);
  });
```

In `test/auth-service.e2e-spec.ts`, import `Metrics` and change `new LoginAttemptLimiter(redis)` to `new LoginAttemptLimiter(redis, new Metrics())`.

In `test/rate-limit-http.e2e-spec.ts`, import `Metrics` and `sampleOf`, and in `'runs out far sooner than the login budget does'` record before the loop:

```ts
      const refusals = async () =>
        (await sampleOf(harness.app.get(Metrics), 'rate_limit_rejections_total', {
          rule: 'deviceActivation',
        })) ?? 0;
      const before = await refusals();
```

and add at the end:

```ts
      // Filed under the route's own rule, not the global backstop.
      expect(await refusals()).toBe(before + 1);
```

In `test/redis-outage-http.e2e-spec.ts`, add inside `describe('the metrics it serves')`:

```ts
    const uncounted = async (policy: 'allow' | 'refuse') =>
      (await sampleOf(
        harness.app.get(Metrics),
        'rate_limit_backend_unavailable_total',
        { policy },
      )) ?? 0;

    it('counts a request served uncounted', async () => {
      const before = await uncounted('allow');

      await harness
        .http()
        .get('/api/v1/categories')
        .set('Authorization', `Bearer ${staffToken}`);

      expect(await uncounted('allow')).toBe(before + 1);
    });

    it('counts a request refused because it could not be counted', async () => {
      const before = await uncounted('refuse');

      await harness
        .http()
        .post('/api/v1/devices/activate')
        .send({ pairingCode: 'ZZZZ9999' });

      expect(await uncounted('refuse')).toBe(before + 1);
    });
```

Run: `NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 npx jest --config ./test/jest-e2e.json test/login-attempt-limiter.e2e-spec.ts test/auth-service.e2e-spec.ts test/rate-limit-http.e2e-spec.ts test/redis-outage-http.e2e-spec.ts`
Expected: FAIL to compile (the limiter takes one argument).

- [ ] **Step 4: Implement it**

In `src/identity/rate-limit/identity-throttler.guard.ts`, add `Inject` to the `@nestjs/common` import, import `Metrics`, and import `RATE_LIMIT_RULE` and `type RateLimitRuleName` from `./rate-limits`. Add to the class:

```ts
  // Property injection: ThrottlerGuard's constructor takes decorated tokens a subclass would have to repeat.
  @Inject(Metrics) private readonly metrics!: Metrics;
```

In `withoutABackend`, directly after `policy` is computed:

```ts
    this.metrics.rateLimitBackendUnavailable.inc({ policy });
```

As the first statement of `throwThrottlingException`:

```ts
    this.metrics.rateLimitRejections.inc({ rule: this.ruleOf(context) });
```

and add:

```ts
  private ruleOf(context: ExecutionContext): RateLimitRuleName {
    return (
      this.reflector.getAllAndOverride<RateLimitRuleName | undefined>(
        RATE_LIMIT_RULE,
        [context.getHandler(), context.getClass()],
      ) ?? 'staffGeneral'
    );
  }
```

In `src/identity/rate-limit/login-attempt.limiter.ts`, import `Metrics` and `LOCKOUT_RULE`, add `private readonly metrics: Metrics,` as the second constructor parameter, and directly after `if (failures < MAX_FAILURES) return;`:

```ts
    this.metrics.rateLimitRejections.inc({ rule: LOCKOUT_RULE });
```

Run the four suites from Step 3.
Expected: PASS.

- [ ] **Step 5: Falsify**

1. Make `ruleOf` always return `'staffGeneral'`. Expected: RED on the device-activation assertion.
2. Move the lockout increment above `if (failures < MAX_FAILURES) return;`. Expected: RED on "counts each attempt it refuses, and none it allows".

- [ ] **Step 6: Verify and commit**

Run the full e2e suite once (the decorator change touches the login and pairing routes). Then typecheck, lint, unit tests.

```bash
git add src test
git commit -m "Count every request a rate limit refuses, under the rule that refused it"
```

---

### Task 9: Turn §13's alerts into rules with tests that can fail

Reviewable on one question: does every alert have a case that must fire and a case that must not, and do the must-not cases cover the conditions that make it noisy (closed hours, low volume, one instance)?

**Files:**
- Create: `ops/prometheus/prometheus.yml`
- Create: `ops/prometheus/alerts.yml`
- Create: `ops/prometheus/alerts.test.yml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the Prometheus config**

Create `ops/prometheus/prometheus.yml`:

```yaml
# Local development: scrapes the API running on the host (pnpm start:dev) and
# evaluates the alert rules against it. A deployment scrapes each instance's
# METRICS_PORT with a configuration of its own; the rules expect job="cafepos".
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - alerts.yml

scrape_configs:
  - job_name: cafepos
    static_configs:
      - targets: ['host.docker.internal:9464']
```

- [ ] **Step 2: Write the rules**

Create `ops/prometheus/alerts.yml`:

```yaml
# The §13 alerts, evaluated against what the app exports on METRICS_PORT.
#
# Every rule carries severity "page" (wake someone) or "notify" (business
# hours). Routing on that label belongs to the deployment's Alertmanager.
# Counters are summed across instances. Gauges read from the database are
# reported identically by every instance and are read with max.
#
# Tested by alerts.test.yml, which CI runs with promtool.
groups:
  - name: cafepos-availability
    rules:
      - alert: ApiDown
        expr: sum(up{job="cafepos"}) == 0
        for: 1m
        labels:
          severity: page
        annotations:
          summary: "No CafePOS instance is answering, so no kiosk can take an order."

      - alert: InstanceDown
        expr: up{job="cafepos"} == 0
        for: 2m
        labels:
          severity: notify
        annotations:
          summary: "A CafePOS instance is not answering scrapes."

      - alert: DatabaseDown
        expr: max(dependency_up{dependency="postgres"}) == 0
        for: 1m
        labels:
          severity: page
        annotations:
          summary: "No instance can reach Postgres."

      - alert: RedisDown
        expr: max(dependency_up{dependency="redis"}) == 0
        for: 2m
        labels:
          severity: notify
        annotations:
          summary: "No instance can reach Redis. Logins and kiosk pairing are refused until it is back."

  - name: cafepos-money
    rules:
      - alert: ReconciliationDelta
        expr: max(abs(reconciliation_delta_minor)) > 0
        labels:
          severity: page
        annotations:
          summary: "The gateway and the books disagree about yesterday's takings."

      # Both instances run the nightly job; one failing while the other checked is not an unchecked night.
      - alert: ReconciliationFailed
        expr: |
          sum(increase(reconciliation_runs_total{outcome="failed"}[1d])) > 0
          unless
          sum(increase(reconciliation_runs_total{outcome=~"agreed|delta"}[1d])) > 0
        labels:
          severity: page
        annotations:
          summary: "No instance could check yesterday's takings against the gateway."

      - alert: WebhookProcessingFailures
        expr: sum(increase(webhook_processing_failures_total[10m])) > 0
        labels:
          severity: page
        annotations:
          summary: "A payment webhook failed to process."

      - alert: PaymentInboxStuck
        expr: max(payment_inbox_oldest_unprocessed_age_seconds) > 120
        labels:
          severity: page
        annotations:
          summary: "A payment event has sat unprocessed for over two minutes."

      - alert: WebhookLagHigh
        expr: histogram_quantile(0.95, sum by (le) (rate(webhook_lag_seconds_bucket[10m]))) > 60
        labels:
          severity: notify
        annotations:
          summary: "Stripe events are reaching us more than a minute late."

      # Five attempts: at 07:00 one declined card in three payments is a customer, not an incident.
      - alert: PaymentFailureRatio
        expr: |
          (
            sum(increase(payments_total{provider="STRIPE",status="FAILED"}[10m]))
            /
            sum(increase(payments_total{provider="STRIPE",status=~"SUCCEEDED|FAILED"}[10m]))
          ) > 0.1
          and
          sum(increase(payments_total{provider="STRIPE",status=~"SUCCEEDED|FAILED"}[10m])) >= 5
        labels:
          severity: notify
        annotations:
          summary: "More than 10% of card and PromptPay payments are failing."

      - alert: PendingPaymentOverdue
        expr: max(orders_pending_payment_overdue_seconds) > 300
        labels:
          severity: notify
        annotations:
          summary: "An unpaid order is five minutes past its expiry. Is the expiry job running?"

  - name: cafepos-trading
    rules:
      - alert: KitchenBlind
        expr: sum(ws_connected{namespace="kds"}) == 0 and on() max(business_open) == 1
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "No kitchen screen is connected while the cafe is open."

      # Open for the whole window, so the first 15 minutes after opening cannot fire it.
      - alert: OrdersSilent
        expr: sum(increase(orders_created_total[15m])) == 0 and on() min_over_time(max(business_open)[15m:1m]) == 1
        labels:
          severity: notify
        annotations:
          summary: "No orders for 15 minutes while the cafe is open."

      - alert: KioskOffline
        expr: max by (device) (kiosk_last_seen_age_seconds) > 120 and on() max(business_open) == 1
        labels:
          severity: notify
        annotations:
          summary: "A kiosk has not been heard from for two minutes while the cafe is open."

      # Reports call the gateway once per payment, and a quiet route's p95 is one request.
      - alert: LatencyP95High
        expr: |
          histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{route!~"/api/v1/reports/.*|unmatched"}[5m]))) > 0.3
          and on(route)
          sum by (route) (rate(http_request_duration_seconds_count{route!~"/api/v1/reports/.*|unmatched"}[5m])) > 0.05
        for: 5m
        labels:
          severity: notify
        annotations:
          summary: "A route's p95 response time is above 300 ms."
```

- [ ] **Step 3: Write the rule tests**

Create `ops/prometheus/alerts.test.yml`:

```yaml
# `promtool test rules alerts.test.yml`. Every alert has a case that must fire
# and a case that must not; the must-not cases are the conditions that would
# otherwise make it noisy.
rule_files:
  - alerts.yml

evaluation_interval: 1m

tests:
  # Every instance down: the API is down, and each instance is down.
  - interval: 1m
    input_series:
      - series: 'up{job="cafepos",instance="a:9464"}'
        values: '0x5'
      - series: 'up{job="cafepos",instance="b:9464"}'
        values: '0x5'
    alert_rule_test:
      - eval_time: 3m
        alertname: ApiDown
        exp_alerts:
          - exp_labels:
              severity: page
            exp_annotations:
              summary: "No CafePOS instance is answering, so no kiosk can take an order."
      - eval_time: 3m
        alertname: InstanceDown
        exp_alerts:
          - exp_labels:
              severity: notify
              job: cafepos
              instance: 'a:9464'
            exp_annotations:
              summary: "A CafePOS instance is not answering scrapes."
          - exp_labels:
              severity: notify
              job: cafepos
              instance: 'b:9464'
            exp_annotations:
              summary: "A CafePOS instance is not answering scrapes."

  # One instance down: the API is still up.
  - interval: 1m
    input_series:
      - series: 'up{job="cafepos",instance="a:9464"}'
        values: '1x5'
      - series: 'up{job="cafepos",instance="b:9464"}'
        values: '0x5'
    alert_rule_test:
      - eval_time: 3m
        alertname: ApiDown
        exp_alerts: []
      - eval_time: 3m
        alertname: InstanceDown
        exp_alerts:
          - exp_labels:
              severity: notify
              job: cafepos
              instance: 'b:9464'
            exp_annotations:
              summary: "A CafePOS instance is not answering scrapes."

  # No instance reaches either dependency.
  - interval: 1m
    input_series:
      - series: 'dependency_up{instance="a:9464",dependency="postgres"}'
        values: '0x5'
      - series: 'dependency_up{instance="b:9464",dependency="postgres"}'
        values: '0x5'
      - series: 'dependency_up{instance="a:9464",dependency="redis"}'
        values: '0x5'
      - series: 'dependency_up{instance="b:9464",dependency="redis"}'
        values: '0x5'
    alert_rule_test:
      - eval_time: 3m
        alertname: DatabaseDown
        exp_alerts:
          - exp_labels:
              severity: page
            exp_annotations:
              summary: "No instance can reach Postgres."
      - eval_time: 3m
        alertname: RedisDown
        exp_alerts:
          - exp_labels:
              severity: notify
            exp_annotations:
              summary: "No instance can reach Redis. Logins and kiosk pairing are refused until it is back."

  # One instance still reaches both: that instance is the problem, not the dependency.
  - interval: 1m
    input_series:
      - series: 'dependency_up{instance="a:9464",dependency="postgres"}'
        values: '0x5'
      - series: 'dependency_up{instance="b:9464",dependency="postgres"}'
        values: '1x5'
      - series: 'dependency_up{instance="a:9464",dependency="redis"}'
        values: '0x5'
      - series: 'dependency_up{instance="b:9464",dependency="redis"}'
        values: '1x5'
    alert_rule_test:
      - eval_time: 3m
        alertname: DatabaseDown
        exp_alerts: []
      - eval_time: 3m
        alertname: RedisDown
        exp_alerts: []

  # A delta pages; a zero does not.
  - interval: 1m
    input_series:
      - series: 'reconciliation_delta_minor{instance="a:9464"}'
        values: '-1000 -1000 -1000'
      - series: 'reconciliation_delta_minor{instance="b:9464"}'
        values: '0 0 0'
    alert_rule_test:
      - eval_time: 1m
        alertname: ReconciliationDelta
        exp_alerts:
          - exp_labels:
              severity: page
            exp_annotations:
              summary: "The gateway and the books disagree about yesterday's takings."
  - interval: 1m
    input_series:
      - series: 'reconciliation_delta_minor{instance="a:9464"}'
        values: '0 0 0'
    alert_rule_test:
      - eval_time: 1m
        alertname: ReconciliationDelta
        exp_alerts: []

  # The only run failed.
  - interval: 1m
    input_series:
      - series: 'reconciliation_runs_total{instance="a:9464",outcome="failed"}'
        values: '0x4 1x10'
      - series: 'reconciliation_runs_total{instance="a:9464",outcome="agreed"}'
        values: '0x14'
      - series: 'reconciliation_runs_total{instance="a:9464",outcome="delta"}'
        values: '0x14'
    alert_rule_test:
      - eval_time: 10m
        alertname: ReconciliationFailed
        exp_alerts:
          - exp_labels:
              severity: page
            exp_annotations:
              summary: "No instance could check yesterday's takings against the gateway."

  # One instance failed, the other checked the books the same night.
  - interval: 1m
    input_series:
      - series: 'reconciliation_runs_total{instance="a:9464",outcome="failed"}'
        values: '0x4 1x10'
      - series: 'reconciliation_runs_total{instance="b:9464",outcome="agreed"}'
        values: '0x4 1x10'
    alert_rule_test:
      - eval_time: 10m
        alertname: ReconciliationFailed
        exp_alerts: []

  # A processing failure pages; a quiet counter does not.
  - interval: 1m
    input_series:
      - series: 'webhook_processing_failures_total{instance="a:9464"}'
        values: '0x4 1x5'
    alert_rule_test:
      - eval_time: 3m
        alertname: WebhookProcessingFailures
        exp_alerts: []
      - eval_time: 7m
        alertname: WebhookProcessingFailures
        exp_alerts:
          - exp_labels:
              severity: page
            exp_annotations:
              summary: "A payment webhook failed to process."

  # Thirty seconds is a sweep in progress; three minutes is stuck.
  - interval: 1m
    input_series:
      - series: 'payment_inbox_oldest_unprocessed_age_seconds{instance="a:9464"}'
        values: '30 180'
    alert_rule_test:
      - eval_time: 0m
        alertname: PaymentInboxStuck
        exp_alerts: []
      - eval_time: 1m
        alertname: PaymentInboxStuck
        exp_alerts:
          - exp_labels:
              severity: page
            exp_annotations:
              summary: "A payment event has sat unprocessed for over two minutes."

  # Every event arrives between one and five minutes late.
  - interval: 1m
    input_series:
      - series: 'webhook_lag_seconds_bucket{instance="a:9464",le="1"}'
        values: '0x15'
      - series: 'webhook_lag_seconds_bucket{instance="a:9464",le="60"}'
        values: '0x15'
      - series: 'webhook_lag_seconds_bucket{instance="a:9464",le="300"}'
        values: '0+1x15'
      - series: 'webhook_lag_seconds_bucket{instance="a:9464",le="+Inf"}'
        values: '0+1x15'
    alert_rule_test:
      - eval_time: 15m
        alertname: WebhookLagHigh
        exp_alerts:
          - exp_labels:
              severity: notify
            exp_annotations:
              summary: "Stripe events are reaching us more than a minute late."

  # Every event arrives within a second.
  - interval: 1m
    input_series:
      - series: 'webhook_lag_seconds_bucket{instance="a:9464",le="1"}'
        values: '0+1x15'
      - series: 'webhook_lag_seconds_bucket{instance="a:9464",le="60"}'
        values: '0+1x15'
      - series: 'webhook_lag_seconds_bucket{instance="a:9464",le="300"}'
        values: '0+1x15'
      - series: 'webhook_lag_seconds_bucket{instance="a:9464",le="+Inf"}'
        values: '0+1x15'
    alert_rule_test:
      - eval_time: 15m
        alertname: WebhookLagHigh
        exp_alerts: []

  # Half of Stripe payments fail. The cash volume must not dilute that.
  - interval: 1m
    input_series:
      - series: 'payments_total{instance="a:9464",provider="STRIPE",status="FAILED"}'
        values: '0+1x15'
      - series: 'payments_total{instance="a:9464",provider="STRIPE",status="SUCCEEDED"}'
        values: '0+1x15'
      - series: 'payments_total{instance="a:9464",provider="CASH",status="SUCCEEDED"}'
        values: '0+100x15'
    alert_rule_test:
      - eval_time: 15m
        alertname: PaymentFailureRatio
        exp_alerts:
          - exp_labels:
              severity: notify
            exp_annotations:
              summary: "More than 10% of card and PromptPay payments are failing."

  # One failure in three payments: a high ratio on too few attempts to mean anything.
  - interval: 1m
    input_series:
      - series: 'payments_total{instance="a:9464",provider="STRIPE",status="FAILED"}'
        values: '0x10 1x5'
      - series: 'payments_total{instance="a:9464",provider="STRIPE",status="SUCCEEDED"}'
        values: '0x10 2x5'
    alert_rule_test:
      - eval_time: 15m
        alertname: PaymentFailureRatio
        exp_alerts: []

  # Busy and healthy.
  - interval: 1m
    input_series:
      - series: 'payments_total{instance="a:9464",provider="STRIPE",status="FAILED"}'
        values: '0x15'
      - series: 'payments_total{instance="a:9464",provider="STRIPE",status="SUCCEEDED"}'
        values: '0+2x15'
    alert_rule_test:
      - eval_time: 15m
        alertname: PaymentFailureRatio
        exp_alerts: []

  # A minute past expiry is the sweep's own granularity; ten minutes is a dead sweep.
  - interval: 1m
    input_series:
      - series: 'orders_pending_payment_overdue_seconds{instance="a:9464"}'
        values: '60 600'
    alert_rule_test:
      - eval_time: 0m
        alertname: PendingPaymentOverdue
        exp_alerts: []
      - eval_time: 1m
        alertname: PendingPaymentOverdue
        exp_alerts:
          - exp_labels:
              severity: notify
            exp_annotations:
              summary: "An unpaid order is five minutes past its expiry. Is the expiry job running?"

  # Open, no kitchen screen on either instance. Board sockets are not kitchen screens.
  - interval: 1m
    input_series:
      - series: 'ws_connected{instance="a:9464",namespace="kds"}'
        values: '0x5'
      - series: 'ws_connected{instance="b:9464",namespace="kds"}'
        values: '0x5'
      - series: 'ws_connected{instance="a:9464",namespace="board"}'
        values: '3x5'
      - series: 'business_open{instance="a:9464"}'
        values: '1x5'
      - series: 'business_open{instance="b:9464"}'
        values: '1x5'
    alert_rule_test:
      - eval_time: 3m
        alertname: KitchenBlind
        exp_alerts:
          - exp_labels:
              severity: page
            exp_annotations:
              summary: "No kitchen screen is connected while the cafe is open."

  # Closed, no kitchen screen: nobody is cooking.
  - interval: 1m
    input_series:
      - series: 'ws_connected{instance="a:9464",namespace="kds"}'
        values: '0x5'
      - series: 'business_open{instance="a:9464"}'
        values: '0x5'
    alert_rule_test:
      - eval_time: 3m
        alertname: KitchenBlind
        exp_alerts: []

  # Open, one screen connected to the other instance.
  - interval: 1m
    input_series:
      - series: 'ws_connected{instance="a:9464",namespace="kds"}'
        values: '0x5'
      - series: 'ws_connected{instance="b:9464",namespace="kds"}'
        values: '1x5'
      - series: 'business_open{instance="a:9464"}'
        values: '1x5'
    alert_rule_test:
      - eval_time: 3m
        alertname: KitchenBlind
        exp_alerts: []

  # Open all window, no orders on either channel.
  - interval: 1m
    input_series:
      - series: 'orders_created_total{instance="a:9464",channel="KIOSK"}'
        values: '40x20'
      - series: 'orders_created_total{instance="a:9464",channel="COUNTER"}'
        values: '12x20'
      - series: 'business_open{instance="a:9464"}'
        values: '1x20'
    alert_rule_test:
      - eval_time: 20m
        alertname: OrdersSilent
        exp_alerts:
          - exp_labels:
              severity: notify
            exp_annotations:
              summary: "No orders for 15 minutes while the cafe is open."

  # Opened ten minutes ago: the quiet stretch includes time the cafe was closed.
  - interval: 1m
    input_series:
      - series: 'orders_created_total{instance="a:9464",channel="KIOSK"}'
        values: '40x20'
      - series: 'business_open{instance="a:9464"}'
        values: '0x9 1x11'
    alert_rule_test:
      - eval_time: 20m
        alertname: OrdersSilent
        exp_alerts: []

  # Open and trading.
  - interval: 1m
    input_series:
      - series: 'orders_created_total{instance="a:9464",channel="KIOSK"}'
        values: '0+1x20'
      - series: 'business_open{instance="a:9464"}'
        values: '1x20'
    alert_rule_test:
      - eval_time: 20m
        alertname: OrdersSilent
        exp_alerts: []

  # One kiosk silent, reported by both instances: one alert, not two.
  - interval: 1m
    input_series:
      - series: 'kiosk_last_seen_age_seconds{instance="a:9464",device="k1"}'
        values: '300x3'
      - series: 'kiosk_last_seen_age_seconds{instance="b:9464",device="k1"}'
        values: '300x3'
      - series: 'kiosk_last_seen_age_seconds{instance="a:9464",device="k2"}'
        values: '30x3'
      - series: 'business_open{instance="a:9464"}'
        values: '1x3'
    alert_rule_test:
      - eval_time: 1m
        alertname: KioskOffline
        exp_alerts:
          - exp_labels:
              severity: notify
              device: k1
            exp_annotations:
              summary: "A kiosk has not been heard from for two minutes while the cafe is open."

  # The same kiosk overnight: switched off, as it should be.
  - interval: 1m
    input_series:
      - series: 'kiosk_last_seen_age_seconds{instance="a:9464",device="k1"}'
        values: '300x3'
      - series: 'business_open{instance="a:9464"}'
        values: '0x3'
    alert_rule_test:
      - eval_time: 1m
        alertname: KioskOffline
        exp_alerts: []

  # Orders is slow with traffic; the Z-report is slow and excluded; users is slow on one request.
  - interval: 1m
    input_series:
      - series: 'http_request_duration_seconds_bucket{instance="a:9464",method="GET",route="/api/v1/orders",status_class="2xx",le="0.3"}'
        values: '0x20'
      - series: 'http_request_duration_seconds_bucket{instance="a:9464",method="GET",route="/api/v1/orders",status_class="2xx",le="1"}'
        values: '0+10x20'
      - series: 'http_request_duration_seconds_bucket{instance="a:9464",method="GET",route="/api/v1/orders",status_class="2xx",le="+Inf"}'
        values: '0+10x20'
      - series: 'http_request_duration_seconds_count{instance="a:9464",method="GET",route="/api/v1/orders",status_class="2xx"}'
        values: '0+10x20'
      - series: 'http_request_duration_seconds_bucket{instance="a:9464",method="GET",route="/api/v1/reports/z-report",status_class="2xx",le="0.3"}'
        values: '0x20'
      - series: 'http_request_duration_seconds_bucket{instance="a:9464",method="GET",route="/api/v1/reports/z-report",status_class="2xx",le="1"}'
        values: '0+10x20'
      - series: 'http_request_duration_seconds_bucket{instance="a:9464",method="GET",route="/api/v1/reports/z-report",status_class="2xx",le="+Inf"}'
        values: '0+10x20'
      - series: 'http_request_duration_seconds_count{instance="a:9464",method="GET",route="/api/v1/reports/z-report",status_class="2xx"}'
        values: '0+10x20'
      - series: 'http_request_duration_seconds_bucket{instance="a:9464",method="GET",route="/api/v1/users",status_class="2xx",le="0.3"}'
        values: '0x20'
      - series: 'http_request_duration_seconds_bucket{instance="a:9464",method="GET",route="/api/v1/users",status_class="2xx",le="1"}'
        values: '0x11 1x9'
      - series: 'http_request_duration_seconds_bucket{instance="a:9464",method="GET",route="/api/v1/users",status_class="2xx",le="+Inf"}'
        values: '0x11 1x9'
      - series: 'http_request_duration_seconds_count{instance="a:9464",method="GET",route="/api/v1/users",status_class="2xx"}'
        values: '0x11 1x9'
    alert_rule_test:
      - eval_time: 15m
        alertname: LatencyP95High
        exp_alerts:
          - exp_labels:
              severity: notify
              route: /api/v1/orders
            exp_annotations:
              summary: "A route's p95 response time is above 300 ms."
```

- [ ] **Step 4: Run the rule tests**

Docker Desktop must be running. From PowerShell at the repo root:

```powershell
docker run --rm --entrypoint promtool -v "${PWD}/ops/prometheus:/etc/prometheus:ro" prom/prometheus:v3.14.0 check config /etc/prometheus/prometheus.yml
docker run --rm --entrypoint promtool -v "${PWD}/ops/prometheus:/etc/prometheus:ro" prom/prometheus:v3.14.0 test rules /etc/prometheus/alerts.test.yml
```

(From Git Bash, prefix each with `MSYS_NO_PATHCONV=1` and use `"$(pwd -W)/ops/prometheus"` for the mount.)

Expected: `SUCCESS` from both. If a case fails on an `increase()` value near a threshold, widen the fixture's margin rather than moving the threshold; the thresholds come from the spec.

- [ ] **Step 5: Falsify the rules**

One at a time, restoring after each; each must turn `test rules` red:
1. Delete `and on() max(business_open) == 1` from `KioskOffline` (the overnight case fires).
2. Replace `max by (device) (kiosk_last_seen_age_seconds)` with `kiosk_last_seen_age_seconds` (two alerts for k1).
3. Delete `provider="STRIPE",` from the ratio's numerator and denominator (the cash volume dilutes the firing case).
4. Delete the `unless` clause from `ReconciliationFailed` (the second instance's success no longer suppresses it).
5. Change `min_over_time(max(business_open)[15m:1m])` to `max(business_open)` (the just-opened case fires).
6. Delete the `and on(route) ... > 0.05` clause from `LatencyP95High` (the one-request users route fires).

- [ ] **Step 6: Run the rules in CI**

In `.github/workflows/ci.yml`, add as the first step after `- uses: actions/checkout@v4`:

```yaml
      # The alert rules are code, and promtool runs their tests. Pinned to the
      # release docker-compose runs, so they are tested against the Prometheus
      # that evaluates them.
      - name: Test alert rules
        run: |
          docker run --rm --entrypoint promtool \
            -v "$PWD/ops/prometheus:/etc/prometheus:ro" \
            prom/prometheus:v3.14.0 check config /etc/prometheus/prometheus.yml
          docker run --rm --entrypoint promtool \
            -v "$PWD/ops/prometheus:/etc/prometheus:ro" \
            prom/prometheus:v3.14.0 test rules /etc/prometheus/alerts.test.yml
```

- [ ] **Step 7: Commit**

```bash
git add ops/prometheus .github/workflows/ci.yml
git commit -m "Turn the section 13 alerts into rules with tests that can fail"
```

---

### Task 10: Watch it locally, and keep the rules and the dashboard honest

Prometheus and Grafana in compose, one dashboard, and the cross-check that stops a renamed metric from leaving an alert silently evaluating nothing.

**Files:**
- Modify: `docker-compose.yml`
- Create: `ops/grafana/provisioning/datasources/prometheus.yml`
- Create: `ops/grafana/provisioning/dashboards/cafepos.yml`
- Create: `ops/grafana/dashboards/cafepos.json`
- Modify: `package.json`, `pnpm-lock.yaml`
- Create: `test/fixtures/promql.ts`
- Modify: `test/metrics.e2e-spec.ts`

- [ ] **Step 1: Add the services behind a profile**

In `docker-compose.yml`, add after the `stripe-mock` service:

```yaml
  # Watches the API running on the host (METRICS_PORT 9464) and evaluates
  # ops/prometheus/alerts.yml against it, so a rule can be watched firing
  # before it is trusted to page anyone. Behind a profile, so a plain
  # `docker compose up -d` still starts only what the tests need:
  #   docker compose --profile observability up -d
  prometheus:
    image: prom/prometheus:v3.14.0
    container_name: cafepos-prometheus
    restart: unless-stopped
    profiles: [observability]
    ports:
      - '9090:9090'
    volumes:
      - ./ops/prometheus:/etc/prometheus:ro
      - cafepos_prometheusdata:/prometheus
    # Docker Desktop resolves host.docker.internal by itself; this makes a Linux engine do the same.
    extra_hosts:
      - 'host.docker.internal:host-gateway'
  grafana:
    image: grafana/grafana:13.2.2
    container_name: cafepos-grafana
    restart: unless-stopped
    profiles: [observability]
    depends_on: [prometheus]
    ports:
      # 3000 is the API.
      - '3001:3000'
    environment:
      # Local only: no login screen between a developer and the dashboard.
      GF_AUTH_ANONYMOUS_ENABLED: 'true'
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
      GF_AUTH_DISABLE_LOGIN_FORM: 'true'
    volumes:
      - ./ops/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./ops/grafana/dashboards:/var/lib/grafana/dashboards:ro
```

and add `cafepos_prometheusdata:` under `volumes:`.

- [ ] **Step 2: Provision Grafana**

Create `ops/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

Create `ops/grafana/provisioning/dashboards/cafepos.yml`:

```yaml
apiVersion: 1
providers:
  - name: cafepos
    folder: CafePOS
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

Create `ops/grafana/dashboards/cafepos.json`:

```json
{
  "uid": "cafepos-overview",
  "title": "CafePOS",
  "tags": ["cafepos"],
  "timezone": "browser",
  "schemaVersion": 39,
  "version": 1,
  "editable": true,
  "refresh": "30s",
  "time": { "from": "now-6h", "to": "now" },
  "panels": [
    {
      "id": 1, "type": "stat", "title": "Cafe open",
      "gridPos": { "h": 4, "w": 4, "x": 0, "y": 0 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "max(business_open)" }]
    },
    {
      "id": 2, "type": "stat", "title": "Postgres",
      "gridPos": { "h": 4, "w": 4, "x": 4, "y": 0 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "max(dependency_up{dependency=\"postgres\"})" }]
    },
    {
      "id": 3, "type": "stat", "title": "Redis",
      "gridPos": { "h": 4, "w": 4, "x": 8, "y": 0 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "max(dependency_up{dependency=\"redis\"})" }]
    },
    {
      "id": 4, "type": "stat", "title": "Kitchen screens",
      "gridPos": { "h": 4, "w": 4, "x": 12, "y": 0 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "sum(ws_connected{namespace=\"kds\"})" }]
    },
    {
      "id": 5, "type": "stat", "title": "Reconciliation delta (satang)",
      "gridPos": { "h": 4, "w": 4, "x": 16, "y": 0 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "max(reconciliation_delta_minor)" }]
    },
    {
      "id": 6, "type": "stat", "title": "Oldest unprocessed webhook",
      "gridPos": { "h": 4, "w": 4, "x": 20, "y": 0 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "s" }, "overrides": [] },
      "targets": [{ "refId": "A", "expr": "max(payment_inbox_oldest_unprocessed_age_seconds)" }]
    },
    {
      "id": 7, "type": "timeseries", "title": "Requests by route",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 4 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "reqps" }, "overrides": [] },
      "targets": [{ "refId": "A", "expr": "sum by (route) (rate(http_request_duration_seconds_count[$__rate_interval]))", "legendFormat": "{{route}}" }]
    },
    {
      "id": 8, "type": "timeseries", "title": "p95 latency by route",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 4 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "s" }, "overrides": [] },
      "targets": [{ "refId": "A", "expr": "histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[$__rate_interval])))", "legendFormat": "{{route}}" }]
    },
    {
      "id": 9, "type": "timeseries", "title": "Orders created",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 12 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "sum by (channel) (increase(orders_created_total[$__rate_interval]))", "legendFormat": "{{channel}}" }]
    },
    {
      "id": 10, "type": "timeseries", "title": "Payments by outcome",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 12 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "sum by (provider, status) (increase(payments_total[$__rate_interval]))", "legendFormat": "{{provider}} {{status}}" }]
    },
    {
      "id": 11, "type": "timeseries", "title": "Webhook lag p95",
      "gridPos": { "h": 8, "w": 8, "x": 0, "y": 20 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "s" }, "overrides": [] },
      "targets": [{ "refId": "A", "expr": "histogram_quantile(0.95, sum by (le) (rate(webhook_lag_seconds_bucket[$__rate_interval])))" }]
    },
    {
      "id": 12, "type": "timeseries", "title": "Webhook processing failures",
      "gridPos": { "h": 8, "w": 8, "x": 8, "y": 20 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "sum(increase(webhook_processing_failures_total[$__rate_interval]))" }]
    },
    {
      "id": 13, "type": "timeseries", "title": "Unpaid orders past expiry",
      "gridPos": { "h": 8, "w": 8, "x": 16, "y": 20 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "s" }, "overrides": [] },
      "targets": [{ "refId": "A", "expr": "max(orders_pending_payment_overdue_seconds)" }]
    },
    {
      "id": 14, "type": "timeseries", "title": "Kiosk last seen",
      "gridPos": { "h": 8, "w": 8, "x": 0, "y": 28 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "s" }, "overrides": [] },
      "targets": [{ "refId": "A", "expr": "max by (device) (kiosk_last_seen_age_seconds)", "legendFormat": "{{device}}" }]
    },
    {
      "id": 15, "type": "timeseries", "title": "Connected screens",
      "gridPos": { "h": 8, "w": 8, "x": 8, "y": 28 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "sum by (namespace) (ws_connected)", "legendFormat": "{{namespace}}" }]
    },
    {
      "id": 16, "type": "timeseries", "title": "Rate-limit refusals",
      "gridPos": { "h": 8, "w": 8, "x": 16, "y": 28 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        { "refId": "A", "expr": "sum by (rule) (increase(rate_limit_rejections_total[$__rate_interval]))", "legendFormat": "{{rule}}" },
        { "refId": "B", "expr": "sum by (policy) (increase(rate_limit_backend_unavailable_total[$__rate_interval]))", "legendFormat": "limiter down: {{policy}}" }
      ]
    },
    {
      "id": 17, "type": "timeseries", "title": "Event loop lag p99",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 36 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "s" }, "overrides": [] },
      "targets": [{ "refId": "A", "expr": "max(nodejs_eventloop_lag_p99_seconds)" }]
    },
    {
      "id": 18, "type": "timeseries", "title": "Scrape-time read failures",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 36 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [{ "refId": "A", "expr": "sum by (collector) (increase(metrics_collector_failures_total[$__rate_interval]))", "legendFormat": "{{collector}}" }]
    }
  ]
}
```

Run `npx prettier --write ops/grafana/dashboards/cafepos.json` so the file matches the repo's formatting.

- [ ] **Step 3: Add the cross-check, test first**

```bash
pnpm add -D yaml@^2.9.1
```

Create `test/fixtures/promql.ts`:

```ts
const NOT_METRICS = new Set([
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'and',
  'or',
  'unless',
  'bool',
  'offset',
  'inf',
  'nan',
]);

/**
 * The metric names a PromQL expression reads.
 *
 * Good enough for the expressions this repository writes, not a parser: label
 * matchers, ranges, grouping clauses and string literals are removed, and what
 * is left that is neither a function call nor a keyword is a metric.
 */
export function metricNamesIn(expr: string): string[] {
  const bare = expr
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, '');

  const names = new Set<string>();
  for (const match of bare.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*/g)) {
    const token = match[0];
    const rest = bare.slice((match.index ?? 0) + token.length).trimStart();
    if (rest.startsWith('(') || NOT_METRICS.has(token.toLowerCase())) continue;
    names.add(token);
  }
  return [...names];
}
```

In `test/metrics.e2e-spec.ts`, add imports:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { metricNamesIn } from './fixtures/promql';
```

and add inside the top-level `describe`:

```ts
  /**
   * A renamed metric leaves every rule and panel that names it evaluating
   * nothing, silently: the config-invisible-to-tests failure PR #5 taught.
   */
  describe('the alert rules and the dashboard', () => {
    const OPS = join(__dirname, '..', 'ops');

    const ruleExpressions = (): string[] => {
      const file = parse(
        readFileSync(join(OPS, 'prometheus', 'alerts.yml'), 'utf8'),
      ) as { groups: { rules: { expr: string }[] }[] };
      return file.groups.flatMap((group) => group.rules.map((rule) => rule.expr));
    };

    const dashboardExpressions = (): string[] => {
      const dashboard = JSON.parse(
        readFileSync(join(OPS, 'grafana', 'dashboards', 'cafepos.json'), 'utf8'),
      ) as { panels: { targets?: { expr: string }[] }[] };
      return dashboard.panels.flatMap((panel) =>
        (panel.targets ?? []).map((target) => target.expr),
      );
    };

    const exposedIn = (text: string): Set<string> => {
      const names = new Set<string>();
      for (const [, name, type] of text.matchAll(/^# TYPE (\S+) (\S+)$/gm)) {
        names.add(name);
        if (type === 'histogram' || type === 'summary') {
          for (const suffix of ['_bucket', '_sum', '_count']) {
            names.add(`${name}${suffix}`);
          }
        }
      }
      return names;
    };

    it('only query metrics the app exports', async () => {
      const referenced = new Set(
        [...ruleExpressions(), ...dashboardExpressions()].flatMap(
          metricNamesIn,
        ),
      );
      // Guards the extractor: had it found nothing, the check below would pass vacuously.
      expect([...referenced]).toEqual(
        expect.arrayContaining([
          'orders_created_total',
          'reconciliation_delta_minor',
          'http_request_duration_seconds_bucket',
          'business_open',
        ]),
      );

      const exposed = exposedIn(await scrape());
      // `up` is written by Prometheus itself, per target.
      const missing = [...referenced].filter(
        (name) => name !== 'up' && !exposed.has(name),
      );
      expect(missing).toEqual([]);
    });
  });
```

Run: `NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 npx jest --config ./test/jest-e2e.json test/metrics.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 4: Falsify the cross-check**

In `alerts.yml`, rename `kiosk_last_seen_age_seconds` in `KioskOffline` to `kiosk_last_seen_seconds`. Expected: RED, `missing` is `['kiosk_last_seen_seconds']`. Restore, green.

- [ ] **Step 5: Watch it for real**

With the compose stack up, run `docker compose --profile observability up -d` and `pnpm start:dev`. Open `http://localhost:9090/targets` and confirm the `cafepos` target is `UP`, and `http://localhost:9090/alerts` shows all fifteen rules loaded. Open `http://localhost:3001` and confirm the CafePOS dashboard renders with data in the request panels. Stop the dev server and confirm `ApiDown` goes pending within a minute. Report what was seen; this step has no automated assertion.

- [ ] **Step 6: Verify and commit**

```bash
git add docker-compose.yml ops/grafana package.json pnpm-lock.yaml test/fixtures/promql.ts test/metrics.e2e-spec.ts
git commit -m "Watch the metrics locally, and keep the rules and dashboard honest"
```

---

### Task 11: Say what shipped

**Files:**
- Modify: `DESIGN.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-22-phase7-metrics-design.md`

- [ ] **Step 1: Amend `DESIGN.md` §13**

Replace the metrics table with:

```markdown
| Metric | Type | Alert when |
|---|---|---|
| `http_request_duration_seconds{method,route,status_class}` | histogram | a route's p95 > 300 ms for 5 min, on at least 3 requests a minute (reports and unmatched paths excluded) |
| `orders_created_total{channel}` | counter | == 0 during business hours for 15 min (the cafe went silent, so something is wrong even if no error fired) |
| `payments_total{provider,status}` | counter | Stripe failure ratio > 10% over 10 min, on at least 5 attempts |
| `webhook_processing_failures_total` | counter | > 0 (every one matters; a lost race with the other instance is not a failure) |
| `webhook_lag_seconds` (first storage minus Stripe event time) | histogram | p95 > 60 s |
| `payment_inbox_oldest_unprocessed_age_seconds` | gauge | > 120 s (a money event is sitting unhandled: refused, crashed, or a dead sweep) |
| `orders_pending_payment_overdue_seconds` | gauge | max > 5 min past expiry (expiry job dead?). Measured past expiry rather than as age, so it holds at any `ORDER_EXPIRY_SECONDS` |
| `reconciliation_delta_minor` (nightly job) | gauge | != 0: gateway and DB disagree about money, page a human. Absent until a run has checked, and cleared when one could not |
| `reconciliation_runs_total{outcome}` | counter | a `failed` run in a day in which no instance completed one |
| `ws_connected{namespace}` | gauge | kds == 0 during business hours (the kitchen is blind) |
| `kiosk_last_seen_age_seconds{device}` | gauge | > 120 s during business hours (kiosk down) |
| `dependency_up{dependency}` | gauge | postgres == 0 on every instance (DB down); redis == 0 on every instance |
| `business_open` | gauge | none; gates the business-hours alerts, from `BUSINESS_OPEN_TIME` and `BUSINESS_CLOSE_TIME` |
| `rate_limit_rejections_total{rule}`, `rate_limit_backend_unavailable_total{policy}` | counter | none; §16's rate limits observed in metrics |
| `metrics_collector_failures_total{collector}` | counter | none; a gauge that could not be read exports no value rather than a stale one |
| DB/Redis: connections, replication, disk | - | platform defaults |
```

Add a paragraph directly after the table:

```markdown
`/metrics` is served on a port of its own (`METRICS_PORT`, default 9464) that the load balancer never routes. The alert rules live in `ops/prometheus/alerts.yml` with `promtool` tests in `alerts.test.yml`, run in CI; each carries `severity: page` or `severity: notify`.
```

Replace the **Alerting routes** paragraph's first two sentences with:

```markdown
**Alerting routes.** Page (immediately): reconciliation delta, a night no instance could reconcile, webhook failures, a stuck payment inbox, API down, DB down, and the kitchen blind during business hours. Notify (business hours): kiosk offline, p95 breach, failure-ratio breach, webhook lag, an unpaid order past its expiry, orders silent, one instance down, Redis down.
```

keeping its "Weekly review" sentence as it is.

In §3's availability row, append ` Configurable as BUSINESS_OPEN_TIME and BUSINESS_CLOSE_TIME.` to the requirement cell.

- [ ] **Step 2: Document it in the README**

In `README.md`'s Configuration table, add after `PORT`:

```markdown
| `METRICS_PORT` | `9464` | Serves `GET /metrics` for Prometheus, and nothing else. Keep it off the load balancer; only `PORT` is public. Must differ from `PORT`. |
```

and after `ORDER_EXPIRY_SECONDS`:

```markdown
| `BUSINESS_OPEN_TIME` | `07:00` | When the cafe opens, `HH:MM` in `BUSINESS_TIMEZONE`. Read only by the alerts that mean nothing overnight. |
| `BUSINESS_CLOSE_TIME` | `20:00` | When it closes. A close earlier than the open wraps past midnight; equal times are refused. |
```

Add a section after "Health endpoints":

```markdown
## Metrics and alerts

`GET /metrics` is served on `METRICS_PORT` (9464), a listener of its own that the load balancer never routes. It exports the metrics `DESIGN.md` §13 lists: request timing by route, orders and payments, webhook lag and failures, the reconciliation delta, connected screens, kiosk ages, dependency status, and rate-limit refusals.

The alert rules are `ops/prometheus/alerts.yml`, tested by `alerts.test.yml`. CI runs them; to run them locally (Docker required):

    docker run --rm --entrypoint promtool -v "${PWD}/ops/prometheus:/etc/prometheus:ro" prom/prometheus:v3.14.0 test rules /etc/prometheus/alerts.test.yml

To watch everything locally, start the monitoring profile alongside the app:

    docker compose --profile observability up -d
    pnpm start:dev

Prometheus is on http://localhost:9090 (scraping the app on the host and evaluating the rules), and Grafana on http://localhost:3001 with the CafePOS dashboard provisioned. Routing alerts to a phone is the deployment's Alertmanager, keyed on each rule's `severity` label.
```

- [ ] **Step 3: Mark the spec implemented**

In the spec, change the status line to `**Status:** implemented on \`phase7-metrics\``.

- [ ] **Step 4: Commit**

```bash
git add DESIGN.md README.md docs/superpowers/specs/2026-09-22-phase7-metrics-design.md
git commit -m "Say what the metrics slice shipped"
```

---

## Verification before handing over

- [ ] `pnpm typecheck`, `pnpm exec eslint "{src,test}/**/*.ts"` and `pnpm test` are clean.
- [ ] The full e2e suite is green: `NODE_ENV=test STRIPE_API_BASE=http://localhost:12111 pnpm test:e2e`. Report the unit and e2e counts against the 416 unit / 763 e2e baseline on `main`.
- [ ] `promtool check config` and `promtool test rules` both print `SUCCESS`.
- [ ] Every falsification step was run and went red, except the one Task 5 names as unfalsified. List them in the hand-over.
- [ ] `git log --format=%B main..HEAD` contains no `Co-Authored-By` line and no em dash.
- [ ] Nothing is pushed. The user decides when to push and open the PR.
