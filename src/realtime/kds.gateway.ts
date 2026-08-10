import {
  Inject,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import type Redis from 'ioredis';
import type { Namespace, Socket } from 'socket.io';
import { describeError } from '../common/errors/describe-error';
import { AccessTokenService } from '../identity/auth/access-token.service';
import type { StaffPrincipal } from '../identity/principal';
import {
  parseRevocation,
  RevocationService,
} from '../identity/revocation/revocation.service';
import { REDIS } from '../redis/redis.constants';
import { attachRedisDiagnostics } from '../redis/redis.diagnostics';
import { NAMESPACES, REVOCATION_CHANNEL } from './realtime.constants';

/** Rooms used purely as an index, so a kill is a room broadcast, not a scan. */
const userRoom = (userId: string): string => `user:${userId}`;
const tokenRoom = (jti: string): string => `token:${jti}`;

/**
 * One message for every rejection.
 *
 * Distinguishing "expired" from "forged" from "revoked" over a socket would
 * hand an attacker an oracle with no rate limiter in front of it — the §10.2
 * throttler guards HTTP routes, and a handshake is not one.
 */
const UNAUTHORIZED = 'unauthorized';

/** What a connected socket carries once the handshake has authenticated it. */
interface KdsSocket extends Socket {
  data: { principal?: StaffPrincipal };
}

/**
 * The staff kitchen-display feed (§5.2, §5.5).
 *
 * Its own namespace rather than a room, because the three audiences of §5.2
 * authenticate differently — a staff JWT here, a device token on `kiosk`,
 * nothing on `board`. A namespace gets its own connection handler, so each gate
 * is a separate piece of code rather than a branch that could fall through and
 * hand a public board client the staff feed.
 */
@WebSocketGateway({ namespace: NAMESPACES.kds })
export class KdsGateway
  implements OnGatewayInit, OnGatewayConnection, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('KdsGateway');
  private subscriber?: Redis;

  @WebSocketServer() private readonly server!: Namespace;

  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly revocations: RevocationService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Authentication runs as handshake **middleware**, not in `handleConnection`.
   *
   * The distinction is not stylistic. `handleConnection` fires *after* the
   * handshake has completed, so rejecting there means an unauthenticated socket
   * genuinely existed, was assigned an id, and joined the namespace before
   * anything hung up on it. Middleware refuses before any of that: the client
   * gets `connect_error` and never a `connect`, and the server never allocates
   * a session for a caller it was always going to turn away.
   *
   * It also makes the failure legible to the client — a rejected handshake is a
   * distinct event from a connection that dropped, which is the difference
   * between "log in again" and "the network blipped, retry".
   */
  afterInit(server: Namespace): void {
    server.use((socket, next) => {
      this.authenticate(socket as KdsSocket)
        .then(() => next())
        .catch((error: Error) => next(error));
    });
  }

  /**
   * Files an authenticated socket into the rooms a kill broadcasts to.
   *
   * Rooms as an index rather than a scan: revoking is then one room emit,
   * whatever the number of connected screens.
   */
  async handleConnection(client: KdsSocket): Promise<void> {
    const principal = client.data.principal;
    // Unreachable — the middleware refuses anything unauthenticated — but a
    // socket that somehow arrived without one must not silently become a
    // listener that no revocation can ever reach.
    if (!principal) {
      client.disconnect(true);
      return;
    }

    await client.join([
      userRoom(principal.userId),
      tokenRoom(principal.tokenId),
    ]);
  }

  /**
   * Resolves the principal, or rejects the handshake.
   *
   * A socket is authenticated exactly once, which is the whole reason
   * `RevocationService` exists: after this returns, nothing re-checks the token
   * for the life of the connection, so the only way to end a session early is
   * for somebody to come and cut it.
   */
  private async authenticate(socket: KdsSocket): Promise<void> {
    const token = bearerFrom(socket);
    if (token === null) throw new Error(UNAUTHORIZED);

    let principal: StaffPrincipal;
    try {
      principal = await this.accessTokens.verify(token);
    } catch {
      throw new Error(UNAUTHORIZED);
    }

    let revoked: boolean;
    try {
      revoked = await this.revocations.isRevoked(principal);
    } catch (error) {
      /**
       * Fails closed. `isRevoked` throws only when Redis is unreachable, and
       * treating that as "not revoked" would make an outage a window in which a
       * deactivated employee reconnects. A refused socket still leaves the KDS
       * its snapshot endpoint (§5.5), so the degraded mode is a board that
       * polls rather than one that goes dark.
       */
      this.logger.warn(
        `Refusing a connection: revocation check unavailable. ${describeError(error)}`,
      );
      throw new Error(UNAUTHORIZED);
    }

    if (revoked) throw new Error(UNAUTHORIZED);

    socket.data.principal = principal;
  }

  /**
   * Pushes an event to every connected staff screen.
   *
   * Namespace-wide rather than per-room: §5.2 gives the whole `kds` audience
   * the same three events, because at a cafe this size every screen shows the
   * same board. The rooms this gateway does maintain exist for revocation, not
   * for routing.
   *
   * Not awaited by callers and deliberately synchronous — Socket.IO hands the
   * payload to the adapter and returns. A publish is best-effort by design
   * (`AfterCommit` explains why the money must not depend on it).
   */
  broadcast(event: string, payload: unknown): void {
    this.server.emit(event, payload);
  }

  /**
   * Subscribes to the kill channel (§10.4).
   *
   * Its own connection because a client in subscriber mode cannot run ordinary
   * commands — sharing the app's client would break the cache and the rate
   * limiter the moment this subscribes.
   */
  onModuleInit(): void {
    this.subscriber = this.redis.duplicate();
    attachRedisDiagnostics(this.subscriber, new Logger('RevocationSubscriber'));

    this.subscriber.on('message', (_channel, raw: string) => {
      const revocation = parseRevocation(raw);
      if (revocation === null) {
        this.logger.warn('Ignoring an unreadable message on the kill channel.');
        return;
      }

      const room =
        'userId' in revocation
          ? userRoom(revocation.userId)
          : tokenRoom(revocation.jti);

      /**
       * `local`, deliberately. Every instance receives this same message and
       * disconnects the sockets *it* holds; a non-local broadcast would have
       * each instance additionally telling every other instance to disconnect
       * the same room, which is N× the work for an outcome already guaranteed.
       */
      this.server.local.in(room).disconnectSockets(true);
    });

    /**
     * Subscribed on `ready`, never awaited here.
     *
     * Awaiting it made a Redis outage at boot fatal: the subscribe rejects,
     * `onModuleInit` rejects with it, and the whole API refuses to start — over
     * a dependency every other consumer in this codebase is careful to degrade
     * around. A cafe whose Redis is down should still be taking orders.
     *
     * `ready` fires on the first connection and on every reconnection after,
     * so the subscription also re-establishes itself when Redis comes back
     * rather than staying silently dead for the life of the process. That
     * matters more here than elsewhere: an instance that misses the kill
     * channel does not fail loudly, it just stops honouring revocations.
     */
    this.subscriber.on('ready', () => {
      this.subscriber
        ?.subscribe(REVOCATION_CHANNEL)
        .catch((error: unknown) =>
          this.logger.error(
            `Could not subscribe to the kill channel; revocations will not reach this instance until Redis recovers. ${describeError(error)}`,
          ),
        );
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.subscriber) return;
    try {
      await this.subscriber.quit();
    } catch {
      // Already gone; a shutdown hook that throws turns a rollout into an
      // incident. Same reasoning as RedisModule's.
      this.subscriber.disconnect();
    }
  }
}

/**
 * Reads the token from the handshake.
 *
 * `auth` is the Socket.IO-native place for it and the one a browser client can
 * actually set; the Authorization header is accepted too so a non-browser
 * client (and the e2e suite) can present credentials the same way it does to
 * every REST route.
 */
const bearerFrom = (socket: Socket): string | null => {
  const fromAuth = (socket.handshake.auth as { token?: unknown }).token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const header = socket.handshake.headers.authorization;
  const match = /^bearer\s+(\S+)$/i.exec(header ?? '');
  return match ? match[1] : null;
};
