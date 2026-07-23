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
 */
export const dailySalesRollups = pgTable('daily_sales_rollups', {
  businessDay: date('business_day').primaryKey(),
  ordersCompleted: integer('orders_completed').notNull().default(0),
  ordersRefunded: integer('orders_refunded').notNull().default(0),
  ordersCancelled: integer('orders_cancelled').notNull().default(0),
  ordersExpired: integer('orders_expired').notNull().default(0),
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
