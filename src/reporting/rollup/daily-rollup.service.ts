import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, asc, eq, gte, isNotNull, lt, notExists, sql } from 'drizzle-orm';
import { describeError } from '../../common/errors/describe-error';
import { BusinessDayNotClosedError } from '../errors/reporting.errors';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { dailySalesRollups, orders } from '../../database/schema';
import { businessDayOf, minusDays } from '../../orders/business-day';
import { aggregateDay } from './aggregate-day';
import { buildRollupRow, type RollupRow } from './build-rollup-row';

/** What one nightly run did. */
export interface RollupSummary {
  rolled: number;
  failed: number;
}

/**
 * How far back a nightly run will look for days it never finalized.
 *
 * Bounded so the sweep cannot degrade into a full scan of `orders` — the exact
 * failure §11.2 lists first. Thirty days comfortably covers any outage the
 * on-call rota would survive; a longer hole is a manual backfill and a
 * conversation, not a job quietly grinding through a year of history.
 */
const CATCH_UP_DAYS = 30;

/**
 * The §11.2 nightly rollup: one finalized row per business day, so historical
 * reports are O(days) instead of a growing scan over live order tables.
 */
@Injectable()
export class DailyRollupService {
  private readonly logger = new Logger(DailyRollupService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Recomputes one business day from live tables and upserts its row.
   *
   * Safe to call repeatedly. The day this runs against is closed — §3.3 freezes
   * its refunds and the guard below refuses anything else — so the aggregation
   * is deterministic and a second run reproduces the first.
   */
  async rollDay(businessDay: string): Promise<RollupRow> {
    /**
     * Only a day that has finished trading may be rolled.
     *
     * The nightly cron cannot trip this: it names a day that closed 22 hours
     * earlier. The guard is here for every *other* caller, because a rollup row
     * is treated as final — `missedDays` skips any day carrying `finalized_at`,
     * so a row written for a partial day would never be corrected. §5.3's
     * Z-report has to serve today flagged `provisional`, which makes
     * `rollDay(today)` the obvious wrong turn for the read slice to take.
     *
     * Throwing rather than returning early: a caller that asked for an open day
     * has a bug, and handing back a silently absent row would let it ship.
     *
     * Lexicographic comparison is exact here — both sides are `YYYY-MM-DD`,
     * zero-padded by `formatDate`, so string order is calendar order.
     */
    const currentBusinessDay = this.businessDayAt(Date.now());
    if (businessDay >= currentBusinessDay) {
      throw new BusinessDayNotClosedError(businessDay, currentBusinessDay);
    }

    const row = buildRollupRow(
      businessDay,
      await aggregateDay(this.db, businessDay),
    );

    const values = {
      businessDay: row.businessDay,
      ordersCompleted: row.ordersCompleted,
      ordersRefunded: row.ordersRefunded,
      ordersCancelled: row.ordersCancelled,
      ordersExpired: row.ordersExpired,
      ordersSettled: row.ordersSettled,
      revenueMinor: row.revenueMinor,
      revenueByMethod: row.revenueByMethod,
      refundsMinor: row.refundsMinor,
      vatMinor: row.vatMinor,
      topItems: row.topItems,
      finalizedAt: new Date(),
    };

    await this.db.insert(dailySalesRollups).values(values).onConflictDoUpdate({
      target: dailySalesRollups.businessDay,
      set: values,
    });

    this.logger.log(
      `Rolled up ${businessDay}: ${row.revenueMinor} minor units across ${row.topItems.length} items.`,
    );

    return row;
  }

  /**
   * 03:00 local, the same slot reconciliation uses and for the same reason:
   * §3.3's business day starts at 05:00, so by three in the morning the day
   * being rolled has been closed for 22 hours and the current one has not
   * begun.
   *
   * Two instances (§11.3) both run this and neither coordinates with the other.
   * The day is closed and §3.3 froze its refunds, so both compute identical
   * numbers and the upsert converges — §9.3's "jobs are idempotent" holding
   * without a distributed lock, exactly as the expiry sweep does. A double run
   * costs one duplicated aggregation inside the dead zone.
   *
   * The literal timezone duplicates the configurable `BUSINESS_TIMEZONE` (same
   * default) because a decorator is evaluated at class-definition time and
   * cannot read `ConfigService`. Reconciliation has the same shape.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'roll-up-yesterday',
    timeZone: 'Asia/Bangkok',
  })
  async rollUpYesterday(): Promise<RollupSummary> {
    const target = this.businessDayAt(Date.now() - 24 * 60 * 60 * 1000);
    return this.rollDays([target, ...(await this.missedDays(target))]);
  }

  /**
   * Rolls each day independently. One bad day must not cost the others theirs:
   * a failure here leaves that day without `finalized_at`, which is exactly the
   * condition the catch-up sweep looks for, so the retry is automatic.
   */
  private async rollDays(days: readonly string[]): Promise<RollupSummary> {
    let rolled = 0;
    let failed = 0;

    for (const day of days) {
      try {
        await this.rollDay(day);
        rolled += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Could not roll up ${day}; it keeps no finalized row and will be retried. ${describeError(error)}`,
        );
      }
    }

    return { rolled, failed };
  }

  /**
   * Business days inside the window that saw trade but carry no finalized
   * rollup — either the job never ran for them, or it ran and failed.
   *
   * Selected from `orders` rather than from a calendar, so the sweep can only
   * ever revisit days that actually happened. A calendar-driven version would
   * manufacture zero rows for every date the cafe was shut.
   */
  private async missedDays(target: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ businessDay: orders.businessDay })
      .from(orders)
      .where(
        and(
          gte(orders.businessDay, minusDays(target, CATCH_UP_DAYS)),
          lt(orders.businessDay, target),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(dailySalesRollups)
              .where(
                and(
                  eq(dailySalesRollups.businessDay, orders.businessDay),
                  isNotNull(dailySalesRollups.finalizedAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(orders.businessDay));

    return rows.map((row) => row.businessDay);
  }

  private businessDayAt(epochMs: number): string {
    return businessDayOf(
      new Date(epochMs),
      this.config.get('BUSINESS_TIMEZONE', { infer: true }),
      this.config.get('BUSINESS_DAY_START_HOUR', { infer: true }),
    );
  }
}
