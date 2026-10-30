import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration. `generate` diffs the schema against the last
 * snapshot and emits SQL into ./drizzle; `migrate` applies pending files.
 * DATABASE_URL is loaded from .env by the dotenv import above.
 *
 * Do not regenerate 0000_nasty_dagger.sql. Its first line,
 * `CREATE EXTENSION IF NOT EXISTS citext;`, was added by hand and drizzle-kit
 * does not reproduce it. citext backs the case-insensitive unique email on
 * `users` (see the customType in src/database/schema/_shared.ts), so a
 * regenerated 0000 fails on a fresh database. Add new migrations instead.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
