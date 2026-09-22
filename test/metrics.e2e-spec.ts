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
