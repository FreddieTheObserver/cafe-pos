import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps, uuidRef } from './_shared';

export const categories = pgTable('categories', {
  id: primaryId(),
  name: text('name').notNull().unique(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

export const menuItems = pgTable(
  'menu_items',
  {
    id: primaryId(),
    categoryId: uuidRef('category_id')
      .notNull()
      .references(() => categories.id),
    name: text('name').notNull(),
    description: text('description'),
    basePriceMinor: integer('base_price_minor').notNull(),
    imageUrl: text('image_url'),
    isAvailable: boolean('is_available').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    check('menu_items_base_price_check', sql`${t.basePriceMinor} >= 0`),
  ],
);

export const optionGroups = pgTable(
  'option_groups',
  {
    id: primaryId(),
    name: text('name').notNull(),
    minSelect: integer('min_select').notNull().default(0),
    maxSelect: integer('max_select').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    check(
      'option_groups_minmax_check',
      sql`${t.minSelect} >= 0 and ${t.minSelect} <= ${t.maxSelect}`,
    ),
  ],
);

export const options = pgTable('options', {
  id: primaryId(),
  optionGroupId: uuidRef('option_group_id')
    .notNull()
    .references(() => optionGroups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  priceDeltaMinor: integer('price_delta_minor').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  isAvailable: boolean('is_available').notNull().default(true),
  ...timestamps,
});

/** Join table: which shared option groups a menu item offers, and in what order. */
export const menuItemOptionGroups = pgTable(
  'menu_item_option_groups',
  {
    menuItemId: uuidRef('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'cascade' }),
    optionGroupId: uuidRef('option_group_id')
      .notNull()
      .references(() => optionGroups.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.menuItemId, t.optionGroupId] })],
);

export const categoriesRelations = relations(categories, ({ many }) => ({
  items: many(menuItems),
}));

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  category: one(categories, {
    fields: [menuItems.categoryId],
    references: [categories.id],
  }),
  optionGroups: many(menuItemOptionGroups),
}));

export const optionGroupsRelations = relations(optionGroups, ({ many }) => ({
  options: many(options),
  menuItems: many(menuItemOptionGroups),
}));

export const optionsRelations = relations(options, ({ one }) => ({
  group: one(optionGroups, {
    fields: [options.optionGroupId],
    references: [optionGroups.id],
  }),
}));

export const menuItemOptionGroupsRelations = relations(
  menuItemOptionGroups,
  ({ one }) => ({
    menuItem: one(menuItems, {
      fields: [menuItemOptionGroups.menuItemId],
      references: [menuItems.id],
    }),
    optionGroup: one(optionGroups, {
      fields: [menuItemOptionGroups.optionGroupId],
      references: [optionGroups.id],
    }),
  }),
);
