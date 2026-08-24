import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  and,
  asc,
  eq,
  gte,
  isNotNull,
  lt,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { describeError } from '../../common/errors/describe-error';
import { BusinessDayNotClosedError } from '../errors/reporting.errors';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { dailySalesRollups, orders } from '../../database/schema';
import { businessDayOf, minusDays } from '../../orders/business-day';
import { aggregateDay } from './aggregate-day';
import { buildRollupRow, type RollupRow } from './build-rollup-row';
import { describeCorrection } from './describe-correction';

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
 * How many closed days before the target are re-rolled unconditionally, even
 * though their rows already carry `finalized_at`.
 *
 * Three, because that is Stripe's retry horizon: a webhook is retried for up to
 * three days, so an event belonging to day D can land as late as D+3 — long
 * after D was rolled at D+1 03:00 — and flip a payment to `SUCCEEDED` on a row
 * already treated as final. An order left `IN_PREPARATION` at close and
 * finished the next morning moves the counts the same way. Rolling D once and
 * then again on D+2, D+3 and D+4 covers the whole window.
 *
 * Wider would re-aggregate history every night for nothing; narrower would
 * leave the tail of the retry window exactly as unhandled as it was before.
 */
const REROLL_DAYS = 3;

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
     * is treated as final — `daysNeedingRoll` revisits an already-finalized day
     * only inside the `REROLL_DAYS` window, so a row written for a partial day
     * ossifies as soon as it falls out of that window. §5.3's
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

    /**
     * Read before the upsert overwrites it, so a re-roll can report what it
     * changed. Correcting a finalized day in silence is its own small version
     * of the bug the re-roll window exists to fix: yesterday's Z-report and
     * today's would disagree with nothing anywhere saying why.
     */
    const [previous] = await this.db
      .select()
      .from(dailySalesRollups)
      .where(eq(dailySalesRollups.businessDay, businessDay))
      .limit(1);

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

    const correction = previous?.finalizedAt
      ? describeCorrection(previous, row)
      : null;

    if (correction) {
      this.logger.warn(
        `Re-rolling ${businessDay} changed a day already finalized: ${correction}. Something landed on it after it was rolled — a webhook Stripe retried past close, or an order finished the next morning.`,
      );
    }

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
    return this.rollDays([target, ...(await this.daysNeedingRoll(target))]);
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
   * Every day besides the target that tonight's run has to roll — two
   * populations, one query.
   *
   * **Inside `REROLL_DAYS`: everything that traded, finalized or not.** A day
   * is not finished changing when it closes. Stripe retries a webhook for up to
   * three days, and an order left `IN_PREPARATION` at close gets completed the
   * next morning; either one lands on a row already written and marked final.
   * The reconciliation job *detects* the money case — a gateway-versus-books
   * delta pages someone — but nothing re-rolled the row, so the stored day
   * simply stayed wrong. Re-rolling costs one aggregation per day and risks
   * nothing: `rollDay` recomputes from the live tables, so a day nothing
   * touched produces the identical row it produced last night.
   *
   * **Older than that: only days carrying no finalized rollup** — the outage
   * case, unchanged. Beyond the retry horizon a finalized day is left alone,
   * which is what keeps the nightly cost flat instead of growing with history.
   *
   * Both populations are selected from `orders` rather than from a calendar, so
   * the sweep can only ever visit days that actually happened. A calendar-driven
   * version would manufacture zero rows for every date the cafe was shut.
   */
  private async daysNeedingRoll(target: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ businessDay: orders.businessDay })
      .from(orders)
      .where(
        and(
          gte(orders.businessDay, minusDays(target, CATCH_UP_DAYS)),
          lt(orders.businessDay, target),
          or(
            gte(orders.businessDay, minusDays(target, REROLL_DAYS)),
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
