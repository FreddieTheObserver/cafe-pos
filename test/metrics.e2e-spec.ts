import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { uuidv7 } from 'uuidv7';
import type { Env } from '../src/config/env.validation';
import * as schema from '../src/database/schema';
import type { OrderStatus } from '../src/database/schema/enums';
import { isOpenAt } from '../src/orders/business-hours';
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
});
