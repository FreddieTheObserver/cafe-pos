import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  and,
  asc,
  eq,
  exists,
  gte,
  isNotNull,
  lt,
  notExists,
  sql,
  sum,
} from 'drizzle-orm';
import { describeError } from '../../common/errors/describe-error';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import {
  dailySalesRollups,
  orderItems,
  orders,
  payments,
  refunds,
} from '../../database/schema';
import { businessDayOf, minusDays } from '../../orders/business-day';
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
   * its refunds and the caller only ever names a day that ended hours ago — so
   * the aggregation is deterministic and a second run reproduces the first.
   */
  async rollDay(businessDay: string): Promise<RollupRow> {
    const row = await this.db.transaction(
      async (tx) => {
        /**
         * "This order took money." Revenue, VAT and top-items all key off this
         * one predicate, which is what keeps the Z-report internally
         * consistent: a VAT figure computed over a different set of orders than
         * the revenue figure would be indefensible at the counter.
         */
        const settled = exists(
          tx
            .select({ one: sql`1` })
            .from(payments)
            .where(
              and(
                eq(payments.orderId, orders.id),
                eq(payments.status, 'SUCCEEDED'),
              ),
            ),
        );

        // q1 — status counts. Deliberately not filtered by `settled`: a
        // cancelled order never paid, and still has to be counted as cancelled.
        const statusCounts = await tx
          .select({
            status: orders.status,
            count: sql<number>`count(*)::int`,
          })
          .from(orders)
          .where(eq(orders.businessDay, businessDay))
          .groupBy(orders.status);

        // q2 — revenue by method. Cash is a payment row like any other, so it
        // lands in the total here and is excluded only from the *gateway*
        // comparison reconciliation makes.
        //
        // `settled` is an order-level predicate; this query needs row-level
        // filtering on individual payments. Reusing `settled` would sum FAILED
        // payment rows that belong to an otherwise-settled order.
        const revenueByMethod = await tx
          .select({
            method: payments.method,
            total: sum(payments.amountMinor),
          })
          .from(payments)
          .innerJoin(orders, eq(payments.orderId, orders.id))
          .where(
            and(
              eq(orders.businessDay, businessDay),
              eq(payments.status, 'SUCCEEDED'),
            ),
          )
          .groupBy(payments.method);

        // q3 — refunds actually settled from the till. A FAILED refund is not
        // money that left the drawer.
        const [{ refunded }] = await tx
          .select({ refunded: sum(refunds.amountMinor) })
          .from(refunds)
          .innerJoin(payments, eq(refunds.paymentId, payments.id))
          .innerJoin(orders, eq(payments.orderId, orders.id))
          .where(
            and(
              eq(orders.businessDay, businessDay),
              eq(refunds.status, 'SUCCEEDED'),
            ),
          );

        // q4 — every item sold, not a truncated leaderboard: a range query
        // sums complete per-day lists, and truncated ones cannot be summed
        // into an exact answer.
        const items = await tx
          .select({
            menuItemId: orderItems.menuItemId,
            name: orderItems.nameSnapshot,
            quantity: sql<number>`sum(${orderItems.quantity})::int`,
            revenue: sum(orderItems.lineTotalMinor),
          })
          .from(orderItems)
          .innerJoin(orders, eq(orderItems.orderId, orders.id))
          .where(and(eq(orders.businessDay, businessDay), settled))
          .groupBy(orderItems.menuItemId, orderItems.nameSnapshot);

        /**
         * q5 — VAT, over distinct orders and with **no join to items**.
         *
         * Merging this into q4 looks like an obvious saving and is wrong: across
         * the `order_items` join each order's VAT would be added once per line
         * on the ticket, so a three-item order would contribute triple. VAT is
         * a per-order figure. Leave these two queries apart.
         */
        const [{ vat }] = await tx
          .select({ vat: sum(orders.vatMinor) })
          .from(orders)
          .where(and(eq(orders.businessDay, businessDay), settled));

        /**
         * `sum()` is typed `string | null` because node-postgres returns
         * numeric and bigint aggregates as text — `'1000' + 500` would be
         * `'1000500'`. Converting at this boundary is what lets everything
         * downstream be plain arithmetic.
         */
        return buildRollupRow(businessDay, {
          statusCounts,
          revenueByMethod: revenueByMethod.map(({ method, total }) => ({
            method,
            totalMinor: Number(total ?? 0),
          })),
          refundsMinor: Number(refunded ?? 0),
          vatMinor: Number(vat ?? 0),
          items: items.map(({ menuItemId, name, quantity, revenue }) => ({
            menuItemId,
            name,
            quantity,
            revenueMinor: Number(revenue ?? 0),
          })),
        });
      },
      /**
       * REPEATABLE READ isolation pins all five queries to one snapshot. Postgres
       * defaults to READ COMMITTED, which re-snapshots per statement, so READ ONLY
       * alone guarantees nothing. The day is closed, so they could not disagree in
       * practice — the isolation level costs nothing and removes the need to reason
       * about snapshot consistency every time someone reads the code.
       */
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );

    const values = {
      businessDay: row.businessDay,
      ordersCompleted: row.ordersCompleted,
      ordersRefunded: row.ordersRefunded,
      ordersCancelled: row.ordersCancelled,
      ordersExpired: row.ordersExpired,
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
