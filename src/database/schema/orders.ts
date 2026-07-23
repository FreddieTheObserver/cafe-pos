import { relations, sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { kioskDevices, users } from './identity';
import { menuItems, options } from './catalog';
import {
  actorTypes,
  orderChannels,
  orderStatuses,
} from './enums';
import { createdAt, inList, primaryId, timestamps, uuidRef } from './_shared';

export const orders = pgTable(
  'orders',
  {
    id: primaryId(),
    orderNumber: text('order_number').notNull(),
    businessDay: date('business_day').notNull(),
    channel: text('channel', { enum: orderChannels }).notNull(),
    status: text('status', { enum: orderStatuses }).notNull(),
    kioskDeviceId: uuidRef('kiosk_device_id').references(() => kioskDevices.id),
    createdByUserId: uuidRef('created_by_user_id').references(() => users.id),
    customerName: text('customer_name'),
    subtotalMinor: integer('subtotal_minor').notNull(),
    vatMinor: integer('vat_minor').notNull(),
    totalMinor: integer('total_minor').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('THB'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('orders_business_day_number_unique').on(t.businessDay, t.orderNumber),
    check('orders_channel_check', inList(t.channel, orderChannels)),
    check('orders_status_check', inList(t.status, orderStatuses)),
    // An order is placed by a kiosk device OR a staff user — never neither.
    check(
      'orders_actor_check',
      sql`${t.kioskDeviceId} is not null or ${t.createdByUserId} is not null`,
    ),
    // KDS snapshot, Z-report, expiry job.
    index('orders_business_day_status_idx').on(t.businessDay, t.status),
    // Cursor pagination (created_at DESC, id DESC).
    index('orders_created_at_id_idx').on(t.createdAt.desc(), t.id.desc()),
    // q= customer-name prefix lookup (partial: most orders have no name).
    index('orders_customer_name_idx')
      .on(t.customerName.op('text_pattern_ops'))
      .where(sql`${t.customerName} is not null`),
    // Kiosk own-order scoping.
    index('orders_kiosk_device_idx').on(t.kioskDeviceId, t.createdAt.desc()),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: primaryId(),
    orderId: uuidRef('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    menuItemId: uuidRef('menu_item_id')
      .notNull()
      .references(() => menuItems.id),
    nameSnapshot: text('name_snapshot').notNull(),
    unitPriceMinorSnapshot: integer('unit_price_minor_snapshot').notNull(),
    quantity: integer('quantity').notNull(),
    lineTotalMinor: integer('line_total_minor').notNull(),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    check('order_items_quantity_check', sql`${t.quantity} between 1 and 50`),
    index('order_items_order_id_idx').on(t.orderId),
    index('order_items_menu_item_idx').on(t.menuItemId, t.createdAt),
  ],
);

export const orderItemOptions = pgTable(
  'order_item_options',
  {
    id: primaryId(),
    orderItemId: uuidRef('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    optionId: uuidRef('option_id')
      .notNull()
      .references(() => options.id),
    groupNameSnapshot: text('group_name_snapshot').notNull(),
    optionNameSnapshot: text('option_name_snapshot').notNull(),
    priceDeltaMinorSnapshot: integer('price_delta_minor_snapshot').notNull(),
    ...timestamps,
  },
  (t) => [index('order_item_options_item_idx').on(t.orderItemId)],
);

/** Append-only audit trail (FR-22). No updated_at — rows are never modified. */
export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: primaryId(),
    orderId: uuidRef('order_id')
      .notNull()
      .references(() => orders.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorType: text('actor_type', { enum: actorTypes }).notNull(),
    actorId: uuidRef('actor_id'),
    createdAt: createdAt(),
  },
  (t) => [
    check('order_status_history_actor_type_check', inList(t.actorType, actorTypes)),
    index('order_status_history_order_idx').on(t.orderId),
  ],
);

/** Backs gapless per-business-day queue numbers via INSERT ... ON CONFLICT (B3, §7.2). */
export const orderNumberCounters = pgTable('order_number_counters', {
  businessDay: date('business_day').primaryKey(),
  lastValue: integer('last_value').notNull().default(0),
});

export const ordersRelations = relations(orders, ({ one, many }) => ({
  kioskDevice: one(kioskDevices, {
    fields: [orders.kioskDeviceId],
    references: [kioskDevices.id],
  }),
  createdByUser: one(users, {
    fields: [orders.createdByUserId],
    references: [users.id],
  }),
  items: many(orderItems),
  statusHistory: many(orderStatusHistory),
}));

export const orderItemsRelations = relations(orderItems, ({ one, many }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  menuItem: one(menuItems, {
    fields: [orderItems.menuItemId],
    references: [menuItems.id],
  }),
  options: many(orderItemOptions),
}));

export const orderItemOptionsRelations = relations(
  orderItemOptions,
  ({ one }) => ({
    orderItem: one(orderItems, {
      fields: [orderItemOptions.orderItemId],
      references: [orderItems.id],
    }),
    option: one(options, {
      fields: [orderItemOptions.optionId],
      references: [options.id],
    }),
  }),
);

export const orderStatusHistoryRelations = relations(
  orderStatusHistory,
  ({ one }) => ({
    order: one(orders, {
      fields: [orderStatusHistory.orderId],
      references: [orders.id],
    }),
  }),
);
