import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { Env } from '../config/env.validation';
import { DRIZZLE } from './drizzle.constants';
import * as schema from './schema';

/** The typed Drizzle client, aware of the full schema for relational queries. */
export type Database = NodePgDatabase<typeof schema>;

const PG_POOL = Symbol('PG_POOL');

/**
 * Pool sizing for one cafe (§11.1: peak ~6 orders/min, < 5 write TPS) running
 * 2 instances (§11.3). Left at pg's defaults these are the wrong shape for the
 * workload — `connectionTimeoutMillis` especially, which defaults to *waiting
 * forever*.
 *
 * `max` 10/instance = 20 connections steady state, 40 mid-rolling-deploy, all
 * far under Postgres's default `max_connections` of 100 with room left for
 * migrations and psql. Connection exhaustion is bottleneck #2 (§11.2), so the
 * ceiling stays deliberately low: this is the number PgBouncer would raise.
 *
 * Timeouts: acquisition fails at 1.5s, inside the readiness probe's 2s budget,
 * so /readyz reports the driver's real error instead of our generic timeout.
 * Idle connections are held 30s (pg defaults to 10s), which spans the lulls
 * between orders without keeping the pool warm all night.
 */
const POOL_OPTIONS = {
  max: 10,
  connectionTimeoutMillis: 1500,
  idleTimeoutMillis: 30_000,
} as const;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          ...POOL_OPTIONS,
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  // The pool is held only so we can drain it on shutdown (zero-downtime deploys, §16).
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
