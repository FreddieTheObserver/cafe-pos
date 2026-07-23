import { sql } from 'drizzle-orm';
import { customType, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/**
 * Every PK is a UUIDv7 (§5.1) — time-ordered, so it plays nicely with B-tree
 * indexes and cursor pagination. Postgres 16 has no native uuidv7(), so we
 * generate it in the app layer via $defaultFn.
 */
export const primaryId = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

/** FK column to some other table's UUIDv7 id (no default; the referenced row owns it). */
export const uuidRef = (name: string) => uuid(name);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** created_at + updated_at, spread into a table's column map. */
export const timestamps = {
  createdAt: createdAt(),
  updatedAt: updatedAt(),
};

/**
 * Case-insensitive text (Postgres `citext` extension). Used for user emails so
 * "A@x.com" and "a@x.com" collide on the UNIQUE index (§7.2). Requires
 * `CREATE EXTENSION citext`, added in the first migration.
 */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * Builds a `column IN ('A','B',...)` expression for a CHECK constraint from an
 * enum tuple. Values are inlined as SQL literals (they come from our own const
 * tuples, never user input) so drizzle-kit emits static DDL.
 */
export const inList = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
