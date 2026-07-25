import { relations, sql } from 'drizzle-orm';
import {
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { orders } from './orders';
import { users } from './identity';
import {
  paymentMethods,
  paymentProviders,
  paymentStatuses,
  refundStatuses,
} from './enums';
import { inList, primaryId, timestamps, uuidRef } from './_shared';

export const payments = pgTable(
  'payments',
  {
    id: primaryId(),
    orderId: uuidRef('order_id')
      .notNull()
      .references(() => orders.id),
    provider: text('provider', { enum: paymentProviders }).notNull(),
    providerIntentId: text('provider_intent_id').unique(),
    method: text('method', { enum: paymentMethods }).notNull(),
    status: text('status', { enum: paymentStatuses }).notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('THB'),
    idempotencyKey: text('idempotency_key').unique(),
    cashTenderedMinor: integer('cash_tendered_minor'),
    ...timestamps,
  },
  (t) => [
    check('payments_provider_check', inList(t.provider, paymentProviders)),
    check('payments_method_check', inList(t.method, paymentMethods)),
    check('payments_status_check', inList(t.status, paymentStatuses)),
    check('payments_amount_check', sql`${t.amountMinor} > 0`),
    index('payments_order_id_idx').on(t.orderId),
    index('payments_provider_intent_idx').on(t.providerIntentId),
    // B4: at most one non-terminal payment per order at a time.
    uniqueIndex('one_live_payment')
      .on(t.orderId)
      .where(sql`${t.status} in ('PENDING', 'PROCESSING')`),
  ],
);

export const refunds = pgTable(
  'refunds',
  {
    id: primaryId(),
    paymentId: uuidRef('payment_id')
      .notNull()
      .references(() => payments.id),
    providerRefundId: text('provider_refund_id').unique(),
    amountMinor: integer('amount_minor').notNull(),
    reason: text('reason'),
    status: text('status', { enum: refundStatuses }).notNull(),
    initiatedByUserId: uuidRef('initiated_by_user_id')
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [
    check('refunds_status_check', inList(t.status, refundStatuses)),
    check('refunds_amount_check', sql`${t.amountMinor} > 0`),
    index('refunds_payment_id_idx').on(t.paymentId),
  ],
);

/** Append-only webhook inbox: store every event before processing (dedupe + replay, §4.2). */
export const paymentEvents = pgTable('payment_events', {
  id: primaryId(),
  providerEventId: text('provider_event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  paymentId: uuidRef('payment_id').references(() => payments.id),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

/** Stores (key, request hash, response) so money-mutating retries replay safely (§5.7). */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('idempotency_keys_expires_at_idx').on(t.expiresAt)],
);

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  order: one(orders, {
    fields: [payments.orderId],
    references: [orders.id],
  }),
  refunds: many(refunds),
  events: many(paymentEvents),
}));

export const refundsRelations = relations(refunds, ({ one }) => ({
  payment: one(payments, {
    fields: [refunds.paymentId],
    references: [payments.id],
  }),
  initiatedBy: one(users, {
    fields: [refunds.initiatedByUserId],
    references: [users.id],
  }),
}));

export const paymentEventsRelations = relations(paymentEvents, ({ one }) => ({
  payment: one(payments, {
    fields: [paymentEvents.paymentId],
    references: [payments.id],
  }),
}));
