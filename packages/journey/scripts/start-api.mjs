import { execSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import pg from 'pg';
import { JOURNEY_DB, PG_ADMIN_URL, REDIS_URL, apiEnv } from '../src/env.ts';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const env = { ...process.env, ...apiEnv() };

const admin = new pg.Client({ connectionString: PG_ADMIN_URL });
await admin.connect();
await admin.query(
  'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
  [JOURNEY_DB],
);
await admin.query(`drop database if exists ${JOURNEY_DB}`);
await admin.query(`create database ${JOURNEY_DB}`);
await admin.end();

const redis = new Redis(REDIS_URL);
await redis.flushdb();
redis.disconnect();

const run = (command) =>
  execSync(command, { cwd: root, env, stdio: 'inherit' });
run('node apps/api/dist/database/migrate.js');
run('pnpm --filter @cafepos/api db:seed');

const api = spawn(process.execPath, ['dist/main.js'], {
  cwd: path.join(root, 'apps/api'),
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => api.kill(signal));
api.on('exit', (code) => process.exit(code ?? 1));
