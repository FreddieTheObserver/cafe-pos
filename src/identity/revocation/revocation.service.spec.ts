import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { Env } from '../../config/env.validation';
import { REVOCATION_CHANNEL } from '../../realtime/realtime.constants';
import type { StaffPrincipal } from '../principal';
import { parseRevocation, RevocationService } from './revocation.service';

const TTL = 900;

const principal: StaffPrincipal = {
  type: 'staff',
  userId: 'user-1',
  role: 'BARISTA',
  tokenId: 'jti-1',
};

/** A Redis whose `mget` answers from a set of keys the test declares. */
const redisWith = (present: string[] = []) => {
  const sets: [string, string, string, number][] = [];
  const published: [string, string][] = [];

  const redis = {
    set: (key: string, value: string, mode: string, ttl: number) => {
      sets.push([key, value, mode, ttl]);
      return Promise.resolve('OK');
    },
    publish: (channel: string, message: string) => {
      published.push([channel, message]);
      return Promise.resolve(1);
    },
    mget: (...keys: string[]) =>
      Promise.resolve(keys.map((key) => (present.includes(key) ? '1' : null))),
  };

  return { redis, sets, published };
};

const build = (redis: unknown) =>
  new RevocationService(
    redis as Redis,
    {
      get: () => TTL,
    } as unknown as ConfigService<Env, true>,
  );

describe('RevocationService', () => {
  it('answers false for a principal nobody has revoked', async () => {
    const { redis } = redisWith();

    await expect(build(redis).isRevoked(principal)).resolves.toBe(false);
  });

  /**
   * The deactivation case, and the reason the denylist is keyed by user at all:
   * the token is still perfectly valid and the person holding it is no longer
   * staff. Nobody deactivating an account knows the `jti` in their browser.
   */
  it('revokes every token a user holds', async () => {
    const { redis, sets, published } = redisWith();
    await build(redis).revokeUser('user-1');

    expect(sets[0][0]).toBe('ws:revoked:user:user-1');
    expect(published[0]).toEqual([
      REVOCATION_CHANNEL,
      JSON.stringify({ userId: 'user-1' }),
    ]);

    const after = redisWith(['ws:revoked:user:user-1']);
    await expect(build(after.redis).isRevoked(principal)).resolves.toBe(true);
  });

  /** Signing out of one screen must not sign you out at the till. */
  it('revokes a single token without touching the rest of the user', async () => {
    const { redis, sets, published } = redisWith();
    await build(redis).revokeToken('jti-1');

    expect(sets[0][0]).toBe('ws:revoked:jti:jti-1');
    expect(published[0][1]).toBe(JSON.stringify({ jti: 'jti-1' }));

    const other: StaffPrincipal = { ...principal, tokenId: 'jti-2' };
    const after = redisWith(['ws:revoked:jti:jti-1']);
    await expect(after.redis.mget('x')).resolves.toEqual([null]);
    await expect(build(after.redis).isRevoked(other)).resolves.toBe(false);
    await expect(build(after.redis).isRevoked(principal)).resolves.toBe(true);
  });

  /**
   * Bounded by the access-token lifetime: an entry for a token that can no
   * longer verify is dead weight, and that bound is what keeps the set small.
   */
  it('expires entries with the token they deny', async () => {
    const { redis, sets } = redisWith();
    await build(redis).revokeUser('user-1');

    expect(sets[0].slice(2)).toEqual(['EX', TTL]);
  });

  /**
   * Written before announced. If the publish won, a subscriber could drop the
   * socket and the immediate reconnect would find no key and be let straight
   * back in.
   */
  it('writes the key before announcing it', async () => {
    const order: string[] = [];
    const redis = {
      set: () => {
        order.push('set');
        return Promise.resolve('OK');
      },
      publish: () => {
        order.push('publish');
        return Promise.resolve(1);
      },
      mget: () => Promise.resolve([]),
    };

    await build(redis).revokeUser('user-1');

    expect(order).toEqual(['set', 'publish']);
  });

  /**
   * The caller has already committed the durable half, so the failure most
   * worth surviving is a reconnect lasting milliseconds.
   */
  it('retries an announcement that fails, and succeeds on a later attempt', async () => {
    let attempts = 0;
    const redis = {
      set: () => {
        attempts += 1;
        return attempts < 3
          ? Promise.reject(new Error('Connection is closed.'))
          : Promise.resolve('OK');
      },
      publish: () => Promise.resolve(1),
      mget: () => Promise.resolve([]),
    };

    await expect(build(redis).revokeUser('user-1')).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  /**
   * Bounded on purpose. If Redis is down rather than blipping, no number of
   * attempts helps and each one delays a response to work that already
   * succeeded — so it gives up and lets the caller log for a human.
   */
  it('gives up rather than retrying forever', async () => {
    let attempts = 0;
    const redis = {
      set: () => {
        attempts += 1;
        return Promise.reject(new Error('Connection is closed.'));
      },
      publish: () => Promise.resolve(1),
      mget: () => Promise.resolve([]),
    };

    await expect(build(redis).revokeUser('user-1')).rejects.toThrow(
      'Connection is closed.',
    );
    // One attempt, then one per configured backoff step.
    expect(attempts).toBe(4);
  });

  /** A retry re-runs both halves, so both have to tolerate being repeated. */
  it('is safe to repeat — the key is rewritten and the message resent', async () => {
    const { redis, sets, published } = redisWith();
    const flaky = {
      ...redis,
      publish: (channel: string, message: string) => {
        const result = redis.publish(channel, message);
        return published.length < 2
          ? Promise.reject(new Error('Connection is closed.'))
          : result;
      },
    };

    await build(flaky).revokeUser('user-1');

    expect(sets.length).toBe(2);
    expect(sets[0]).toEqual(sets[1]);
    expect(published[0]).toEqual(published[1]);
  });

  /**
   * Fails closed. Every other Redis dependency in this codebase fails open;
   * an authorization check must not, or an outage becomes a window in which a
   * revoked principal reconnects.
   */
  it('propagates a Redis outage rather than reporting "not revoked"', async () => {
    const redis = {
      mget: () => Promise.reject(new Error('Connection is closed.')),
    };

    await expect(build(redis).isRevoked(principal)).rejects.toThrow(
      'Connection is closed.',
    );
  });
});

describe('parseRevocation', () => {
  it.each([
    ['{"userId":"u1"}', { userId: 'u1' }],
    ['{"jti":"j1"}', { jti: 'j1' }],
  ])('reads %s', (raw, expected) => {
    expect(parseRevocation(raw)).toEqual(expected);
  });

  /**
   * The channel is a shared Redis instance, not a typed call — anything on the
   * box can publish to it, and a subscriber that threw would take itself down
   * over somebody else's typo.
   */
  it.each([
    ['not json at all'],
    ['null'],
    ['[]'],
    ['{}'],
    ['{"userId":""}'],
    ['{"userId":42}'],
  ])('refuses %s without throwing', (raw) => {
    expect(parseRevocation(raw)).toBeNull();
  });

  /**
   * A message naming both is ambiguous, and resolving it to `userId` would
   * quietly pick the *broader* revocation — cutting every session a person has
   * because a sender got the shape wrong.
   */
  it('refuses a message that names both a user and a token', () => {
    expect(parseRevocation('{"userId":"u1","jti":"j1"}')).toBeNull();
  });
});
