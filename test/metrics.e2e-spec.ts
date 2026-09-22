import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import { Metrics } from '../src/observability/metrics/metrics';
import { MetricsServer } from '../src/observability/metrics/metrics-server';
import { sampleOf } from '../src/observability/metrics/sample-of';
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
});
