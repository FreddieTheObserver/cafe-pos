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
    /**
     * Which rail the money actually came down — **not known when the row is
     * written** for a gateway payment, which is why this is nullable.
     *
     * §5.3 has the kiosk naming the method up front and this column was NOT
     * NULL to match. Stripe's guidance is the opposite and is emphatic about
     * it: never pin `payment_method_types`, because doing so opts out of
     * dynamic payment methods and freezes the accepted rails into deployed
     * code. So the customer chooses inside the Payment Element, after the
     * PaymentIntent already exists, and the webhook tells us what they chose.
     *
     * NULL therefore means "a gateway payment that has not resolved yet" — a
     * state that only exists between creation and the terminal webhook. CASH
     * never passes through Stripe and is written with its method set, so a
     * NULL here is always a card-or-PromptPay attempt still in flight.
     *
     * The CHECK below still holds: `NULL in (...)` is NULL, and a constraint
     * fails only on FALSE.
     */
    method: text('method', { enum: paymentMethods }),
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
    // §7.3 wants an index on provider_intent_id for webhook → payment matching;
    // the column's UNIQUE constraint already supplies one. A second explicit
    // index would cost an extra B-tree write per insert on that hot path.
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

/**
 * Stores (key, request hash, response) so money-mutating retries replay safely
 * (§5.7).
 *
 * The response columns are **nullable, and that is the concurrency design**.
 * The row is inserted at the start of the request's transaction, before there
 * is anything to store — so a retry that arrives while the original is still
 * running blocks on this primary key rather than racing it into a second order.
 * NULL means "reserved, not yet answered"; it is only ever observed by a
 * transaction that is itself blocked, and never by a reader, because the row
 * becomes visible only when the transaction that filled it commits.
 *
 * A refused order therefore stores nothing at all: the reservation dies with
 * the rolled-back transaction, and the kiosk is free to retry an order that
 * failed because an item was briefly sold out.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').primaryKey(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
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
