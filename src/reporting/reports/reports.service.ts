import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, exists, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { DependencyUnavailableError } from '../../common/errors/dependency-unavailable.error';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { dailySalesRollups, orders, payments } from '../../database/schema';
import { businessDayOf, eachBusinessDay } from '../../orders/business-day';
import { aggregateDay } from '../rollup/aggregate-day';
import { buildRollupRow, type RollupRow } from '../rollup/build-rollup-row';
import { UnprocessableRangeError } from '../errors/reporting.errors';
import { avgTicketMinor, salesBucket, type SalesBucket } from './shape-reports';

/**
 * How many days in one request may be aggregated live.
 *
 * A range normally has at most one — today, or a day closed too recently for
 * the 03:00 run. Needing thirty means the nightly job has been failing for a
 * month, and serving that request slowly would hide an operational fault behind
 * a spinner. Past this, the request is refused with a 503 that names the count.
 *
 * This bounds the `groupBy=day` stitching path only. It must NOT be applied to
 * `groupBy=hour`, which is live across its whole range by definition — a 31-day
 * hourly query is at its own legitimate maximum, and checking it here would
 * reject the largest valid request.
 */
export const MAX_LIVE_DAYS = 31;

/** The `GET /reports/sales` body (§5.2). */
export interface SalesReport {
  from: string;
  to: string;
  groupBy: 'day' | 'hour';
  /** True exactly when the range includes the business day still taking money. */
  provisional: boolean;
  buckets: SalesBucket[];
}

@Injectable()
export class ReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The business day currently taking money (§3.3). */
  currentBusinessDay(): string {
    return businessDayOf(
      new Date(),
      this.config.get('BUSINESS_TIMEZONE', { infer: true }),
      this.config.get('BUSINESS_DAY_START_HOUR', { infer: true }),
    );
  }

  /**
   * Totals for each requested business day, from whichever source is correct.
   *
   * A finalized rollup is read; anything else is aggregated live with the same
   * function that produced the rollups. Both paths return a `RollupRow`, so no
   * caller downstream can tell — or accidentally depend on — where a day came
   * from.
   */
  async dayTotals(days: readonly string[]): Promise<Map<string, RollupRow>> {
    if (days.length === 0) return new Map();

    /**
     * Assumes `days` is sorted ascending, which is what `eachBusinessDay`
     * returns and what every caller passes. The first and last entries become
     * the bounds of the single range query below; an unsorted input would
     * silently narrow that range and send days to the live path that already
     * had rollups.
     */
    const from = days[0];
    const to = days[days.length - 1];

    /**
     * One query for every rolled day in the range, rather than one per day.
     * This is what makes §11.2's "historical reports are O(days)" true of the
     * request and not merely of the storage.
     */
    const stored = await this.db
      .select()
      .from(dailySalesRollups)
      .where(
        and(
          gte(dailySalesRollups.businessDay, from),
          lte(dailySalesRollups.businessDay, to),
          isNotNull(dailySalesRollups.finalizedAt),
        ),
      );

    const totals = new Map<string, RollupRow>();
    for (const row of stored) {
      totals.set(row.businessDay, {
        businessDay: row.businessDay,
        ordersCompleted: row.ordersCompleted,
        ordersRefunded: row.ordersRefunded,
        ordersCancelled: row.ordersCancelled,
        ordersExpired: row.ordersExpired,
        ordersSettled: row.ordersSettled,
        revenueMinor: row.revenueMinor,
        revenueByMethod: row.revenueByMethod as Record<string, number>,
        refundsMinor: row.refundsMinor,
        vatMinor: row.vatMinor,
        topItems: row.topItems as RollupRow['topItems'],
      });
    }

    const missing = days.filter((day) => !totals.has(day));

    if (missing.length > MAX_LIVE_DAYS) {
      throw new DependencyUnavailableError(
        `${missing.length} of the ${days.length} days requested have no finalized rollup, which is past the ${MAX_LIVE_DAYS}-day limit this endpoint will compute on demand. The nightly rollup has not been running.`,
      );
    }

    for (const day of missing) {
      totals.set(day, buildRollupRow(day, await aggregateDay(this.db, day)));
    }

    return totals;
  }

  async salesReport(query: {
    from: string;
    to: string;
    groupBy: 'day' | 'hour';
  }): Promise<SalesReport> {
    const current = this.currentBusinessDay();

    /**
     * A range ending after today is a client bug. Refusing beats aggregating
     * days that have not happened to return guaranteed-zero buckets, which
     * would read as data.
     */
    if (query.to > current) {
      throw new UnprocessableRangeError(
        `to must not be after the current business day (${current})`,
      );
    }

    const days = eachBusinessDay(query.from, query.to);

    if (query.groupBy === 'hour') {
      return {
        from: query.from,
        to: query.to,
        groupBy: 'hour',
        provisional: days.includes(current),
        buckets: await this.hourlyBuckets(query.from, query.to),
      };
    }

    const totals = await this.dayTotals(days);

    return {
      from: query.from,
      to: query.to,
      groupBy: 'day',
      provisional: days.includes(current),
      buckets: days.map((day) => salesBucket(day, totals.get(day)!)),
    };
  }

  /**
   * Hourly buckets, always live.
   *
   * The bucket label is keyed by business day, not by the calendar date the
   * wall-clock hour falls on. With a nonzero `BUSINESS_DAY_START_HOUR`, an
   * order in the small hours belongs to *yesterday's* business day while its
   * calendar date already reads today — labelling by calendar date would put
   * that order's bucket outside a range that correctly includes it, silently
   * every night the shift crosses midnight. Grouping is by output position
   * (the `bucket` label) because the timezone travels as a bound parameter:
   * naming the expression again in GROUP BY emits a second placeholder, and
   * Postgres will not match the two. Ordering is by `min(created_at)`, which
   * keeps the small-hours buckets of a business day sorted after its evening
   * hours rather than before them.
   *
   * Only orders that took money are counted, matching the daily path's
   * `settled` predicate.
   *
   * Deliberately not routed through `dayTotals` — the missing-rollup cap there
   * bounds how much of a *stitched* range may be absent, which has no meaning
   * for a path that is live by definition.
   */
  private async hourlyBuckets(
    from: string,
    to: string,
  ): Promise<SalesBucket[]> {
    const zone = this.config.get('BUSINESS_TIMEZONE', { infer: true });
    const localHour = sql`date_trunc('hour', ${orders.createdAt} AT TIME ZONE ${zone})`;

    const rows = await this.db
      .select({
        bucket: sql<string>`${orders.businessDay} || 'T' || to_char(${localHour}, 'HH24')`,
        revenueMinor: sql<number>`coalesce(sum(${orders.totalMinor}), 0)::bigint`,
        ordersSettled: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(
        and(
          gte(orders.businessDay, from),
          lte(orders.businessDay, to),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(payments)
              .where(
                and(
                  eq(payments.orderId, orders.id),
                  eq(payments.status, 'SUCCEEDED'),
                ),
              ),
          ),
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`min(${orders.createdAt})`);

    return rows.map((row) => ({
      bucket: row.bucket,
      revenueMinor: Number(row.revenueMinor),
      ordersSettled: row.ordersSettled,
      avgTicketMinor: avgTicketMinor(
        Number(row.revenueMinor),
        row.ordersSettled,
      ),
    }));
  }
}
