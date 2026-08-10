import { Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { describeError } from '../common/errors/describe-error';
import { DeviceTokenService } from '../identity/devices/device-token.service';
import type { DevicePrincipal } from '../identity/principal';
import { deviceRoom, NAMESPACES } from './realtime.constants';
import { RevocationSubscriber } from './revocation-subscriber.service';

const UNAUTHORIZED = 'unauthorized';

interface KioskSocket extends Socket {
  data: { principal?: DevicePrincipal };
}

/**
 * The kiosk's own feed (§5.2, §12.3).
 *
 * Its own namespace because a tablet authenticates with an opaque device token
 * rather than a staff JWT, and because what it may hear is narrower than
 * anything else on the system: **events about its own order only**. §6.4 scopes
 * a kiosk to what it placed, and a namespace that broadcast to every device
 * would hand a tablet in a public space a live feed of the cafe's takings.
 *
 * That scoping is the `device:<id>` room, and it is the reason this gateway
 * has rooms at all — unlike `kds`, where rooms exist purely so a revocation can
 * be a single emit.
 */
@WebSocketGateway({ namespace: NAMESPACES.kiosk })
export class KioskGateway
  implements OnGatewayInit, OnGatewayConnection, OnModuleInit
{
  private readonly logger = new Logger('KioskGateway');

  @WebSocketServer() private readonly server!: Namespace;

  constructor(
    private readonly deviceTokens: DeviceTokenService,
    private readonly revocationFeed: RevocationSubscriber,
  ) {}

  /**
   * Handshake middleware, for the reason the KDS gateway spells out: rejecting
   * in `handleConnection` would let an unauthenticated socket exist first.
   *
   * There is no denylist check here, and that asymmetry is deliberate. A device
   * token is resolved against `kiosk_devices` on every use (§6.2 calls that the
   * thing JWTs trade away), so a revoked tablet fails this step against the
   * source of truth. Only an *already open* socket needs the kill channel.
   */
  afterInit(server: Namespace): void {
    server.use((socket, next) => {
      this.authenticate(socket as KioskSocket)
        .then(() => next())
        .catch((error: Error) => next(error));
    });
  }

  async handleConnection(client: KioskSocket): Promise<void> {
    const principal = client.data.principal;
    if (!principal) {
      client.disconnect(true);
      return;
    }

    await client.join(deviceRoom(principal.deviceId));
  }

  /** Cuts a revoked tablet's socket (§10.1). */
  onModuleInit(): void {
    this.revocationFeed.onRevocation((revocation) => {
      // Staff revocations name a user or a token and belong to `kds`.
      if (!('deviceId' in revocation)) return;

      this.server.local
        .in(deviceRoom(revocation.deviceId))
        .disconnectSockets(true);
    });
  }

  /**
   * The heartbeat §5.5 asks for, on the cadence `last_seen_at` already uses.
   *
   * Every instance reports the sockets *it* holds, and the union across them is
   * the truth — which is why this reads the local registry rather than asking
   * the adapter to poll the cluster: a device connected to instance B is B's to
   * report, and asking A about it would be a round trip to learn something A
   * cannot know better.
   *
   * Best-effort. A failed write leaves the device list a minute stale, which is
   * the same staleness a tablet that simply has not called yet produces, and it
   * is not worth an error a human is asked to look at.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'kiosk-presence' })
  async recordPresence(): Promise<void> {
    // Undefined until a gateway has been initialised — a cron tick can land
    // during boot, before Socket.IO has handed the namespace over.
    if (!this.server) return;

    const connected = [...this.server.sockets.values()]
      .map((socket) => (socket as KioskSocket).data.principal?.deviceId)
      .filter((deviceId): deviceId is string => deviceId !== undefined);

    // Two tabs on one tablet is one device; the set keeps the update honest.
    const deviceIds = [...new Set(connected)];
    if (deviceIds.length === 0) return;

    try {
      await this.deviceTokens.markSeen(deviceIds);
    } catch (error) {
      this.logger.warn(
        `Could not record presence for ${deviceIds.length} connected kiosk(s); the device list will read stale. ${describeError(error)}`,
      );
    }
  }

  /**
   * Pushes an event to one device, and only that device.
   *
   * Room-scoped rather than namespace-wide: `payment.succeeded` names an order,
   * and the customer standing at kiosk 2 has no business learning that the
   * person at kiosk 1 just paid.
   */
  emitToDevice(deviceId: string, event: string, payload: unknown): void {
    this.server.in(deviceRoom(deviceId)).emit(event, payload);
  }

  private async authenticate(socket: KioskSocket): Promise<void> {
    const token = bearerFrom(socket);
    if (token === null) throw new Error(UNAUTHORIZED);

    let principal: DevicePrincipal;
    try {
      /**
       * `resolve` also refreshes `last_seen_at`, which is what §5.5 wants from
       * a heartbeat — a tablet that reconnects is a tablet that is alive, and
       * the device health view learns it without a separate ping.
       */
      principal = await this.deviceTokens.resolve(token);
    } catch {
      // One message for every rejection: revoked, unpaired and forged must not
      // be distinguishable to something holding a stolen tablet.
      throw new Error(UNAUTHORIZED);
    }

    socket.data.principal = principal;
  }
}

const bearerFrom = (socket: Socket): string | null => {
  const fromAuth = (socket.handshake.auth as { token?: unknown }).token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const header = socket.handshake.headers.authorization;
  const match = /^bearer\s+(\S+)$/i.exec(header ?? '');
  return match ? match[1] : null;
};
