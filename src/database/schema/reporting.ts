import {
  bigint,
  date,
  integer,
  jsonb,
  pgTable,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Nightly rollup so historical reports don't scan live order tables (§11.2).
 * One row per finalized business day; revenue in satang can exceed int range,
 * hence bigint.
 *
 * `mode: 'number'` is deliberate. Every per-row money column feeding these sums
 * is `integer` (int32, max ~21.5M THB), so a day would need ~4.2M orders at the
 * maximum possible order total — roughly 90 trillion THB in one business day —
 * before a sum reached Number.MAX_SAFE_INTEGER. Postgres BIGINT is here to clear
 * int32 at the *aggregate* level, not 2^53. Using `mode: 'bigint'` instead would
 * make these values throw on JSON.stringify and stop composing with the `number`
 * arithmetic used everywhere else in the money path.
 */
export const dailySalesRollups = pgTable('daily_sales_rollups', {
  businessDay: date('business_day').primaryKey(),
  ordersCompleted: integer('orders_completed').notNull().default(0),
  ordersRefunded: integer('orders_refunded').notNull().default(0),
  ordersCancelled: integer('orders_cancelled').notNull().default(0),
  ordersExpired: integer('orders_expired').notNull().default(0),
  /**
   * Orders that took money — at least one SUCCEEDED payment.
   *
   * The denominator for avg ticket (§5.2), and deliberately not any of the
   * status counts above: a paid order still sitting in READY at roll time is a
   * sale, and a refunded order was a sale. Counted with the same `settled`
   * predicate revenue and VAT use, so the average cannot be revenue divided by
   * a different set of orders than produced it.
   */
  ordersSettled: integer('orders_settled').notNull().default(0),
  revenueMinor: bigint('revenue_minor', { mode: 'number' })
    .notNull()
    .default(0),
  revenueByMethod: jsonb('revenue_by_method').notNull().default({}),
  refundsMinor: bigint('refunds_minor', { mode: 'number' })
    .notNull()
    .default(0),
  vatMinor: bigint('vat_minor', { mode: 'number' }).notNull().default(0),
  topItems: jsonb('top_items').notNull().default([]),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
});
