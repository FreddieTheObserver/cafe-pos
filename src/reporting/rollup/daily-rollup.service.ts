import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, exists, sql, sum } from 'drizzle-orm';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import {
  dailySalesRollups,
  orderItems,
  orders,
  payments,
  refunds,
} from '../../database/schema';
import { buildRollupRow, type RollupRow } from './build-rollup-row';

/**
 * The §11.2 nightly rollup: one finalized row per business day, so historical
 * reports are O(days) instead of a growing scan over live order tables.
 */
@Injectable()
export class DailyRollupService {
  private readonly logger = new Logger(DailyRollupService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

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
       * One snapshot for all five queries. The day is closed, so they could not
       * disagree in practice — this costs nothing and removes the need to
       * reason about that claim every time someone reads the code.
       */
      { accessMode: 'read only' },
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
}
