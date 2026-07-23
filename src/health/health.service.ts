import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DRIZZLE } from '../database/drizzle.constants';
import type { Database } from '../database/database.module';
import { REDIS } from '../redis/redis.constants';

const CHECK_TIMEOUT_MS = 2000;

export interface DependencyCheck {
  status: 'up' | 'down';
  error?: string;
}

export interface ReadinessResult {
  ok: boolean;
  checks: { db: DependencyCheck; redis: DependencyCheck };
}

/** Rejects if the underlying probe doesn't settle in time (dependency wedged). */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} check timed out after ${CHECK_TIMEOUT_MS}ms`)),
        CHECK_TIMEOUT_MS,
      ).unref(),
    ),
  ]);
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async checkReadiness(): Promise<ReadinessResult> {
    const [db, redis] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
    ]);
    return { ok: db.status === 'up' && redis.status === 'up', checks: { db, redis } };
  }

  private async checkDb(): Promise<DependencyCheck> {
    try {
      await withTimeout(this.db.execute(sql`select 1`), 'db');
      return { status: 'up' };
    } catch (err) {
      return { status: 'down', error: (err as Error).message };
    }
  }

  private async checkRedis(): Promise<DependencyCheck> {
    try {
      const pong = await withTimeout(this.redis.ping(), 'redis');
      return pong === 'PONG'
        ? { status: 'up' }
        : { status: 'down', error: `unexpected ping reply: ${pong}` };
    } catch (err) {
      return { status: 'down', error: (err as Error).message };
    }
  }
}
