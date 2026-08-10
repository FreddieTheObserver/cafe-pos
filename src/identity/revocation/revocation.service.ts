import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { Env } from '../../config/env.validation';
import { REDIS } from '../../redis/redis.constants';
import { REVOCATION_CHANNEL } from '../../realtime/realtime.constants';
import type { StaffPrincipal } from '../principal';

/**
 * What a revocation names. Exactly one of the two, never both.
 *
 * `userId` is the one that matters operationally: a fired employee is
 * deactivated, and nobody deactivating them knows the `jti` of the tokens
 * already in their browser. `jti` exists for the case that *does* know its own
 * token — a staff member signing out of one screen, who should not be signed
 * out of the till at the same time.
 */
export type Revocation = { userId: string } | { jti: string };

const userKey = (userId: string): string => `ws:revoked:user:${userId}`;
const tokenKey = (jti: string): string => `ws:revoked:jti:${jti}`;

/**
 * The §10.4 denylist, finally built — and built for sockets first.
 *
 * §10.4 accepts a 15-minute revocation gap on REST, reasoning that a fired
 * employee's access token dies on its own soon enough. A WebSocket breaks that
 * reasoning: the token is checked once, at connect, and the connection then
 * lives indefinitely. "Fifteen minutes" silently becomes "until they close the
 * tab", which is not a gap anyone accepted.
 *
 * Entries expire after the access-token lifetime, because a denylist entry for
 * a token that can no longer verify is dead weight. That bound is what makes
 * this affordable: the set only ever holds principals revoked within the last
 * token lifetime, not every user ever deactivated.
 */
@Injectable()
export class RevocationService {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true });
  }

  /** Kills every live token for a user — deactivation, demotion (§6.4). */
  async revokeUser(userId: string): Promise<void> {
    await this.announce(userKey(userId), { userId });
  }

  /** Kills one specific token — the signing-out-of-one-screen case. */
  async revokeToken(jti: string): Promise<void> {
    await this.announce(tokenKey(jti), { jti });
  }

  /**
   * Whether this principal has been revoked since its token was minted.
   *
   * Both keys in one round trip. The user key has to be checked even when the
   * token itself is fine, because that is the whole deactivation case: the
   * token is perfectly valid and the person holding it is no longer staff.
   *
   * **Throws on a Redis outage rather than answering "not revoked".** Every
   * other Redis dependency here fails open, and this one must not: failing open
   * on an authorization check means an outage is a window in which a revoked
   * principal reconnects. §10.2 already draws that line — `staffGeneral` fails
   * open, `login` and `deviceActivation` fail closed — and this belongs on the
   * closed side with them. A KDS refused a socket still has the snapshot
   * endpoint (§5.5), so the degraded mode is a board that polls, not a board
   * that goes dark.
   */
  async isRevoked(principal: StaffPrincipal): Promise<boolean> {
    const found = await this.redis.mget(
      userKey(principal.userId),
      tokenKey(principal.tokenId),
    );

    return found.some((value) => value !== null);
  }

  private async announce(key: string, message: Revocation): Promise<void> {
    /**
     * Written before it is announced. A subscriber that acted on the message
     * and then let the principal straight back in would be worse than useless,
     * and that is exactly the race if the publish wins — the reconnect arrives
     * before the key exists and `isRevoked` says no.
     */
    await this.redis.set(key, '1', 'EX', this.ttlSeconds);
    await this.redis.publish(REVOCATION_CHANNEL, JSON.stringify(message));
  }
}

/**
 * Parses a message off the kill channel.
 *
 * Defensive because the channel is a shared Redis instance rather than a typed
 * function call: anything on the box can publish to it, and a gateway that
 * threw on a malformed message would take its own subscriber down over
 * somebody else's typo.
 */
export const parseRevocation = (raw: string): Revocation | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const { userId, jti } = parsed as Record<string, unknown>;
  const namesUser = typeof userId === 'string' && userId.length > 0;
  const namesToken = typeof jti === 'string' && jti.length > 0;

  /**
   * Exactly one, enforced rather than merely documented.
   *
   * Reading whichever field came first would make a message naming both
   * resolve silently to the user-level revocation — the broader of the two —
   * so a sender that got the shape wrong would cut every session a person has
   * and look like it worked. Nothing this service publishes can produce that,
   * but the reason this parser is defensive at all is that the channel is a
   * shared Redis instance rather than a typed call.
   */
  if (namesUser === namesToken) return null;

  return namesUser ? { userId: userId } : { jti: jti as string };
};
