/**
 * Barrel for the full CafePOS schema. drizzle-kit reads this to generate
 * migrations; the Drizzle client is typed against it for relational queries.
 * Mirrors DESIGN.md §7.2 one-to-one.
 */
export * from './enums';
export * from './identity';
export * from './catalog';
export * from './orders';
export * from './payments';
export * from './reporting';
