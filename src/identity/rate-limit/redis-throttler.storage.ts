import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { REDIS } from '../../redis/redis.constants';

/**
 * `ThrottlerStorageRecord` restated structurally.
 *
 * The library declares that name as both an interface and a `unique symbol`,
 * which makes it awkward to reference as a plain type from a test. Writing the
 * shape out keeps the contract explicit and readable at the call site; the
 * `implements ThrottlerStorage` clause below still fails the build if it ever
 * stops matching what the guard expects.
 */
export interface ThrottleRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Counts one hit and reports the window, atomically.
 *
 * A script rather than a MULTI: the block extension has to read the hit count
 * it just wrote, and doing that as separate round trips means two requests can
 * interleave between the INCR and the PEXPIRE — the exact window an attacker
 * running parallel requests is trying to find.
 *
 * KEYS[1] counter key · ARGV: ttl ms, limit, block ms.
 * Returns: total hits, remaining ms, blocked flag.
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ttl)
end

local remaining = redis.call('PTTL', KEYS[1])
local blocked = 0

if hits > limit then
  blocked = 1
  -- A block that outlives the counting window is what makes this a lockout
  -- rather than a limit that lifts as soon as the window rolls over.
  if blockDuration > 0 and remaining < blockDuration then
    redis.call('PEXPIRE', KEYS[1], blockDuration)
    remaining = blockDuration
  end
end

return { hits, remaining, blocked }
`;

/** Redis has millisecond precision; the throttler contract is in whole seconds. */
const toSeconds = (milliseconds: number): number =>
  Math.max(0, Math.ceil(milliseconds / 1000));

/**
 * Rate-limit counters in Redis (§10.2), shared by every API instance.
 *
 * The default in-memory storage would give each pod its own budget, so the
 * real limit would be `limit × instances` and would drift with autoscaling —
 * which is not a limit at all. We already run Redis (§12.1); this is the
 * reason §10.2 names it.
 *
 * Hand-rolled against `ThrottlerStorage` rather than pulling a community
 * adapter, for the same reason `zod-dto` is hand-rolled: it is one script and
 * a unit conversion, and the auth throttle should not follow someone else's
 * release cadence.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottleRecord> {
    const [hits, remainingMs, blocked] = (await this.redis.eval(
      INCREMENT_SCRIPT,
      1,
      `throttle:${throttlerName}:${key}`,
      ttl,
      limit,
      blockDuration,
    )) as [number, number, number];

    const isBlocked = blocked === 1;
    return {
      totalHits: hits,
      timeToExpire: toSeconds(remainingMs),
      isBlocked,
      timeToBlockExpire: isBlocked ? toSeconds(remainingMs) : 0,
    };
  }
}
