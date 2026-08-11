import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, gte, isNotNull, lte } from 'drizzle-orm';
import { DependencyUnavailableError } from '../../common/errors/dependency-unavailable.error';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { dailySalesRollups } from '../../database/schema';
import { businessDayOf } from '../../orders/business-day';
import { aggregateDay } from '../rollup/aggregate-day';
import { buildRollupRow, type RollupRow } from '../rollup/build-rollup-row';

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
}
