import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { describeError } from '../common/errors/describe-error';

// Reads only DATABASE_URL, so a release job can hold a role the app itself lacks.
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: join(__dirname, '..', '..', 'drizzle'),
    });
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`migration failed: ${describeError(error)}\n`);
  process.exitCode = 1;
});
