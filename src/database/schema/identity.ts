import { relations } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { deviceStatuses, userRoles } from './enums';
import { citext, inList, primaryId, timestamps, uuidRef } from './_shared';

export const users = pgTable(
  'users',
  {
    id: primaryId(),
    email: citext('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: userRoles }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [check('users_role_check', inList(t.role, userRoles))],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: primaryId(),
    userId: uuidRef('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: uuidRef('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('refresh_tokens_family_id_idx').on(t.familyId)],
);

export const kioskDevices = pgTable(
  'kiosk_devices',
  {
    id: primaryId(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').unique(),
    pairingCodeHash: text('pairing_code_hash'),
    pairingExpiresAt: timestamp('pairing_expires_at', { withTimezone: true }),
    status: text('status', { enum: deviceStatuses }).notNull().default('PENDING'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    registeredBy: uuidRef('registered_by').references(() => users.id),
    ...timestamps,
  },
  (t) => [check('kiosk_devices_status_check', inList(t.status, deviceStatuses))],
);

export const usersRelations = relations(users, ({ many }) => ({
  refreshTokens: many(refreshTokens),
  registeredDevices: many(kioskDevices),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.userId],
    references: [users.id],
  }),
}));

export const kioskDevicesRelations = relations(kioskDevices, ({ one }) => ({
  registeredByUser: one(users, {
    fields: [kioskDevices.registeredBy],
    references: [users.id],
  }),
}));
