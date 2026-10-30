import { and, eq, exists, sql, sum } from 'drizzle-orm';
import type { Database } from '../../database/database.module';
import { orderItems, orders, payments, refunds } from '../../database/schema';
import type { RollupParts } from './build-rollup-row';

/**
 * What one business day totalled, straight from the live tables.
 *
 * Extracted from the nightly job so the read side can compute a day that has
 * no rollup row — today, or a day closed too recently for the 03:00 run — with
 * exactly the code that produced every other day. Two definitions of "what did
 * this day total" would drift, and the drift would surface as history and today
 * quietly disagreeing, which is the one thing the rollup design cannot afford.
 *
 * Writes nothing. Persisting is `DailyRollupService.rollDay`'s job, and only it
 * is allowed to decide a day is final.
 */
export async function aggregateDay(
  db: Database,
  businessDay: string,
): Promise<RollupParts> {
  return db.transaction(
    async (tx) => {
      /**
       * "This order took money." Revenue, VAT, the settled count and top-items
       * all key off this one predicate, which is what keeps the Z-report
       * internally consistent: a VAT figure computed over a different set of
       * orders than the revenue figure would be indefensible at the counter.
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

      // q1 — status counts. Deliberately not filtered by `settled`: a cancelled
      // order never paid, and still has to be counted as cancelled.
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

      // q4 — every item sold, not a truncated leaderboard: a range query sums
      // complete per-day lists, and truncated ones cannot be summed into an
      // exact answer.
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
       * q5 — VAT and the settled-order count, over distinct orders and with
       * **no join to items**.
       *
       * Merging this into q4 looks like an obvious saving and is wrong: across
       * the `order_items` join each order's VAT would be added once per line on
       * the ticket, so a three-item order would contribute triple, and the
       * count would report lines rather than orders. Both figures are per-order.
       * Leave these two queries apart.
       *
       * The count rides along here rather than in its own query precisely
       * because it needs the same row set as the VAT sum — same FROM, same
       * WHERE, so the denominator and the numerator cannot diverge.
       */
      const [{ vat, settledOrders }] = await tx
        .select({
          vat: sum(orders.vatMinor),
          settledOrders: sql<number>`count(*)::int`,
        })
        .from(orders)
        .where(and(eq(orders.businessDay, businessDay), settled));

      /**
       * `sum()` is typed `string | null` because node-postgres returns numeric
       * and bigint aggregates as text — `'1000' + 500` would be `'1000500'`.
       * Converting at this boundary is what lets everything downstream be plain
       * arithmetic.
       */
      return {
        statusCounts,
        revenueByMethod: revenueByMethod.map(({ method, total }) => ({
          method,
          totalMinor: Number(total ?? 0),
        })),
        refundsMinor: Number(refunded ?? 0),
        vatMinor: Number(vat ?? 0),
        ordersSettled: settledOrders,
        items: items.map(({ menuItemId, name, quantity, revenue }) => ({
          menuItemId,
          name,
          quantity,
          revenueMinor: Number(revenue ?? 0),
        })),
      };
    },
    /**
     * REPEATABLE READ, not merely READ ONLY. Postgres defaults to READ
     * COMMITTED and takes a fresh snapshot per *statement*, so `read only`
     * alone would let the five queries see different data. `read only` is a
     * guard against accidental writes, not an isolation level.
     */
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
