import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration. `generate` diffs the schema against the last
 * snapshot and emits SQL into ./drizzle; `migrate` applies pending files.
 * DATABASE_URL is loaded from .env by the dotenv import above.
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
