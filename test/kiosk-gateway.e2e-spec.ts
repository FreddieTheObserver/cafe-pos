import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import * as schema from '../src/database/schema';
import { RevocationService } from '../src/identity/revocation/revocation.service';
import { NAMESPACES } from '../src/realtime/realtime.constants';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * The `kiosk` namespace (§5.2, §12.3, §10.1).
 *
 * The scoping is the whole test surface here. A tablet in a public space must
 * hear about its own order and nothing else, and must stop hearing anything the
 * moment it is revoked — the two properties that separate this namespace from
 * simply broadcasting to everyone.
 */
describe('Kiosk gateway (e2e)', () => {
  let harness: IdentityHarness;
  let redis: Redis;
  let revocations: RevocationService;
  let managerToken: string;
  let croissantId: string;

  const open = (options: Record<string, unknown> = {}): Socket =>
    io(`${harness.url()}${NAMESPACES.kiosk}`, {
      transports: ['websocket'],
      reconnection: false,
      ...options,
    });

  const connects = (socket: Socket): Promise<boolean> =>
    new Promise((resolve) => {
      const settle = (result: boolean) => {
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => settle(false), 4000);
      socket.on('connect', () => settle(true));
      socket.on('connect_error', () => settle(false));
      socket.on('disconnect', () => settle(false));
    });

  const connected = async (token: string): Promise<Socket> => {
    const socket = open({ auth: { token } });
    await expect(connects(socket)).resolves.toBe(true);
    return socket;
  };

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

  /** Resolves false if `name` never arrives — used to prove silence. */
  const staysQuiet = (
    socket: Socket,
    name: string,
    ms = 1500,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), ms);
      socket.once(name, () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

  const droppedWithin = (socket: Socket, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      socket.on('disconnect', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  const orderFrom = async (token: string): Promise<string> => {
    const res = await harness
      .http()
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        channel: 'KIOSK',
        customerName: 'Mei',
        items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
      });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  /** Marks an order READY, which §5.2 sends to the owning device. */
  const markReady = async (orderId: string): Promise<void> => {
    await harness.db
      .update(schema.orders)
      .set({ status: 'IN_PREPARATION', expiresAt: null })
      .where(eq(schema.orders.id, orderId));

    const res = await harness
      .http()
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ to: 'READY' });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    revocations = new RevocationService(
      redis,
      new ConfigService({ ACCESS_TOKEN_TTL_SECONDS: 900 }),
    );

    managerToken = await harness.accessTokenFor('MANAGER');
    const post = async (path: string, body: Record<string, unknown>) => {
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

    const categoryId = await post('/api/v1/categories', {
      name: `Kiosk pastries ${Date.now()}`,
      sortOrder: 0,
    });
    croissantId = await post('/api/v1/items', {
      categoryId,
      name: `Kiosk croissant ${Date.now()}`,
      basePriceMinor: 2000,
      sortOrder: 0,
    });
  });

  afterAll(async () => {
    try {
      await harness.close();
    } finally {
      redis.disconnect();
    }
  });

  it('lets a paired tablet connect', async () => {
    const device = await harness.createDevice('ACTIVE');
    const socket = await connected(device.token);
    socket.disconnect();
  });

  it('hangs up on a connection carrying no token', async () => {
    await expect(connects(open())).resolves.toBe(false);
  });

  /**
   * §6.2: the two credential kinds are not interchangeable. A staff JWT is not
   * a device token, however valid it is elsewhere.
   */
  it('hangs up on a staff access token', async () => {
    await expect(
      connects(open({ auth: { token: managerToken } })),
    ).resolves.toBe(false);
  });

  it('hangs up on a revoked tablet', async () => {
    const device = await harness.createDevice('ACTIVE');
    await harness.db
      .update(schema.kioskDevices)
      .set({ status: 'REVOKED' })
      .where(eq(schema.kioskDevices.id, device.id));

    await expect(
      connects(open({ auth: { token: device.token } })),
    ).resolves.toBe(false);
  });

  it('tells a kiosk when its own order is ready', async () => {
    const device = await harness.createDevice('ACTIVE');
    const socket = await connected(device.token);
    const orderId = await orderFrom(device.token);

    const arrived = nextEvent(socket, 'order.ready');
    await markReady(orderId);

    expect(await arrived).toMatchObject({ id: orderId, status: 'READY' });
    socket.disconnect();
  });

  /**
   * The property that makes this a namespace with rooms rather than a
   * broadcast. A tablet in a public space learning what the *next* kiosk sold
   * is a disclosure §6.4 scopes away on every other surface.
   */
  it('does not tell a kiosk about another device’s order', async () => {
    const mine = await harness.createDevice('ACTIVE');
    const theirs = await harness.createDevice('ACTIVE');

    const socket = await connected(mine.token);
    const theirOrder = await orderFrom(theirs.token);

    const quiet = staysQuiet(socket, 'order.ready');
    await markReady(theirOrder);

    expect(await quiet).toBe(true);
    socket.disconnect();
  });

  /**
   * §10.1's stolen tablet. The status change stops the *next* connection by
   * itself, because a device token is resolved against the table every time —
   * this is about the socket that is already open.
   */
  it('cuts a live socket when the tablet is revoked', async () => {
    const device = await harness.createDevice('ACTIVE');
    const socket = await connected(device.token);

    const dropped = droppedWithin(socket, 4000);
    await revocations.revokeDevice(device.id);

    await expect(dropped).resolves.toBe(true);
  });
});
