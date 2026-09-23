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
