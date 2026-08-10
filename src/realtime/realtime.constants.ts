/**
 * The three audiences of §5.2, as Socket.IO **namespaces** rather than rooms.
 *
 * §5.5 lists `kds` / `device:<id>` / `board` as rooms, which conflates two
 * things: `kds` and `board` are audiences with different authentication, while
 * `device:<id>` is a fan-out target *within* the kiosk audience. Namespaces get
 * their own connection middleware, so each audience is a separate gate — a
 * staff JWT, a device token, and nothing at all. One namespace with a branching
 * handler would put the public board one bug away from a staff feed, and §10.1
 * is built on the assumption that kiosks are physically accessible.
 */

export const NAMESPACES = {
  kds: '/kds',
  kiosk: '/kiosk',
  board: '/board',
} as const;

/** Rooms live *inside* a namespace. Only the kiosk audience needs one. */
export const deviceRoom = (deviceId: string): string => `device:${deviceId}`;

/**
 * Redis pub/sub channel for D2's revocation kill switch. A revoked token has to
 * reach whichever instance holds the socket, which is not necessarily the one
 * that processed the revocation (§11.3 runs two).
 */
export const REVOCATION_CHANNEL = 'cafepos:auth:revoked';

/** DI token for the realtime publisher port. */
export const REALTIME_PUBLISHER = Symbol('REALTIME_PUBLISHER');
