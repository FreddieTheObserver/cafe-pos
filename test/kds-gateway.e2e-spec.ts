import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import * as schema from '../src/database/schema';
import { io, type Socket } from 'socket.io-client';
import { NAMESPACES } from '../src/realtime/realtime.constants';
import { RevocationService } from '../src/identity/revocation/revocation.service';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * The `kds` namespace (§5.2, §5.5, §10.4).
 *
 * A socket is authenticated once, at connect, and then never again — so these
 * are the tests that decide whether a fired employee's board goes dark. Run
 * against a real Socket.IO client and a real Redis, because the interesting
 * behaviour lives in the handshake and in a pub/sub message crossing between
 * two connections, neither of which a mock would exercise.
 */
describe('KDS gateway (e2e)', () => {
  let harness: IdentityHarness;
  let redis: Redis;
  let revocations: RevocationService;

  const open = (options: Record<string, unknown> = {}): Socket =>
    io(`${harness.url()}${NAMESPACES.kds}`, {
      transports: ['websocket'],
      reconnection: false,
      ...options,
    });

  /** Resolves true if the socket got in, false if the server hung up. */
  const connects = (socket: Socket): Promise<boolean> =>
    new Promise((resolve) => {
      const settle = (result: boolean) => {
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => settle(false), 4000);
      socket.on('connect', () => settle(true));
      socket.on('disconnect', () => settle(false));
      socket.on('connect_error', () => settle(false));
    });

  /** Resolves when the server drops an already-connected socket. */
  const droppedWithin = (socket: Socket, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      socket.on('disconnect', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  const connected = async (token: string): Promise<Socket> => {
    const socket = open({ auth: { token } });
    await expect(connects(socket)).resolves.toBe(true);
    return socket;
  };

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    revocations = new RevocationService(
      redis,
      new ConfigService({ ACCESS_TOKEN_TTL_SECONDS: 900 }),
    );
  });

  afterAll(async () => {
    try {
      await harness.close();
    } finally {
      redis.disconnect();
    }
  });

  it('lets a barista onto the board', async () => {
    const socket = await connected(await harness.accessTokenFor('BARISTA'));
    socket.disconnect();
  });

  it('hangs up on a connection carrying no token', async () => {
    await expect(connects(open())).resolves.toBe(false);
  });

  it('hangs up on a forged token', async () => {
    await expect(
      connects(open({ auth: { token: 'not.a.jwt' } })),
    ).resolves.toBe(false);
  });

  /**
   * §6.2: a kiosk authenticates with an opaque device token, not a JWT. The
   * staff verifier rejecting it is what keeps a tablet in a public space off
   * the staff feed even though both credentials arrive the same way.
   */
  it('hangs up on a kiosk device token', async () => {
    const device = await harness.createDevice('ACTIVE');

    await expect(
      connects(open({ auth: { token: device.token } })),
    ).resolves.toBe(false);
  });

  it('accepts the token in an Authorization header too', async () => {
    const token = await harness.accessTokenFor('MANAGER');
    const socket = open({
      extraHeaders: { Authorization: `Bearer ${token}` },
    });

    await expect(connects(socket)).resolves.toBe(true);
    socket.disconnect();
  });

  /**
   * The deactivation case. The token is still perfectly valid and verifies
   * fine — the person holding it is simply no longer staff.
   */
  it('refuses a connection from a user who has been revoked', async () => {
    const staff = await harness.createStaff('BARISTA');
    const revokedToken = await harness.accessTokenForEmail(staff.email);
    await revocations.revokeUser(staff.id);

    await expect(
      connects(open({ auth: { token: revokedToken } })),
    ).resolves.toBe(false);

    // A token for a *different* user must still get in, or this would pass
    // because the gateway refuses everyone.
    const other = await connected(await harness.accessTokenFor('BARISTA'));
    other.disconnect();
  });

  /**
   * The kill channel (§5.5's "connection dropped on token revocation"). The
   * socket is already open and authenticated; nothing re-checks it, so the only
   * thing that can end it is the message this publishes.
   */
  it('cuts a live socket when its user is revoked', async () => {
    const staff = await harness.createStaff('BARISTA');
    const token = await harness.accessTokenForEmail(staff.email);
    const socket = await connected(token);

    const dropped = droppedWithin(socket, 4000);
    await revocations.revokeUser(staff.id);

    await expect(dropped).resolves.toBe(true);
  });

  /**
   * Signing out at the till must not drop the KDS screen on the wall. Two
   * sockets, same user, different tokens — only the named one dies.
   */
  /**
   * The point of the whole phase: a board that moves without being asked.
   * §17's exit criterion is two screens seeing an event in under 2 s, and these
   * are the events they see.
   */
  describe('receiving events', () => {
    let croissantId: string;
    let baristaToken: string;

    /** Resolves with the payload of the next `name` event, or rejects. */
    const nextEvent = (
      socket: Socket,
      name: string,
      ms = 4000,
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no ${name} within ${ms}ms`)),
          ms,
        );
        socket.once(name, (payload: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(payload);
        });
      });

    const asManager = async (path: string, body: Record<string, unknown>) => {
      const res = await harness
        .http()
        .post(path)
        .set('Authorization', `Bearer ${managerToken}`)
        .send(body);
      if (res.status !== 201) {
        throw new Error(`fixture ${path} failed with ${res.status}`);
      }
      return (res.body as { id: string }).id;
    };

    let managerToken: string;

    beforeAll(async () => {
      managerToken = await harness.accessTokenFor('MANAGER');
      baristaToken = await harness.accessTokenFor('BARISTA');
      const categoryId = await asManager('/api/v1/categories', {
        name: `WS pastries ${Date.now()}`,
        sortOrder: 0,
      });
      croissantId = await asManager('/api/v1/items', {
        categoryId,
        name: `WS croissant ${Date.now()}`,
        basePriceMinor: 2000,
        sortOrder: 0,
      });
    });

    /** A PAID order — §4.4 leaves no endpoint that reaches PAID directly. */
    const paidOrder = async (): Promise<string> => {
      const device = await harness.createDevice('ACTIVE');
      const res = await harness
        .http()
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${device.token}`)
        .send({
          channel: 'KIOSK',
          customerName: 'Mei',
          items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
        });
      expect(res.status).toBe(201);
      const id = (res.body as { id: string }).id;

      await harness.db
        .update(schema.orders)
        .set({ status: 'PAID', expiresAt: null })
        .where(eq(schema.orders.id, id));

      return id;
    };

    const move = (orderId: string, to: string) =>
      harness
        .http()
        .post(`/api/v1/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${baristaToken}`)
        .send({ to });

    it('pushes a full ticket when an order moves, not a diff', async () => {
      const socket = await connected(baristaToken);
      const orderId = await paidOrder();

      const arrived = nextEvent(socket, 'order.updated');
      expect((await move(orderId, 'IN_PREPARATION')).status).toBe(200);

      const ticket = await arrived;
      // §5.5: whole order, so a client can render from the latest event alone.
      expect(ticket).toMatchObject({
        id: orderId,
        status: 'IN_PREPARATION',
        customerName: 'Mei',
      });
      expect(ticket.items).toHaveLength(1);

      socket.disconnect();
    });

    /**
     * READY is its own event because it is the moment a customer can be called
     * — a client that wants to chime does not want to chime on every move.
     */
    it('names the ready transition separately', async () => {
      const socket = await connected(baristaToken);
      const orderId = await paidOrder();
      await move(orderId, 'IN_PREPARATION');

      const arrived = nextEvent(socket, 'order.ready');
      expect((await move(orderId, 'READY')).status).toBe(200);

      expect(await arrived).toMatchObject({ id: orderId, status: 'READY' });
      socket.disconnect();
    });

    /**
     * §17's exit criterion in miniature: two screens, one event, both see it.
     * This is what the Redis adapter exists for — with one instance it would
     * pass regardless, which is why the harness installs the real adapter.
     */
    it('reaches every connected screen', async () => {
      const bar = await connected(baristaToken);
      const counter = await connected(await harness.accessTokenFor('CASHIER'));
      const orderId = await paidOrder();

      const both = Promise.all([
        nextEvent(bar, 'order.updated'),
        nextEvent(counter, 'order.updated'),
      ]);
      await move(orderId, 'IN_PREPARATION');

      const [seenByBar, seenByCounter] = await both;
      expect(seenByBar).toMatchObject({ id: orderId });
      expect(seenByCounter).toMatchObject({ id: orderId });

      bar.disconnect();
      counter.disconnect();
    });
  });

  it('cuts only the named token when a single session is revoked', async () => {
    const staff = await harness.createStaff('CASHIER');
    const till = await harness.accessTokenForEmail(staff.email);
    const wall = await harness.accessTokenForEmail(staff.email);

    const tillSocket = await connected(till);
    const wallSocket = await connected(wall);

    const tillDropped = droppedWithin(tillSocket, 4000);
    const wallDropped = droppedWithin(wallSocket, 1500);

    await revocations.revokeToken(jtiOf(till));

    await expect(tillDropped).resolves.toBe(true);
    await expect(wallDropped).resolves.toBe(false);

    wallSocket.disconnect();
  });
});

/** Reads the `jti` out of a signed access token without verifying it. */
const jtiOf = (token: string): string => {
  const payload = token.split('.')[1];
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as { jti: string };
  return claims.jti;
};
