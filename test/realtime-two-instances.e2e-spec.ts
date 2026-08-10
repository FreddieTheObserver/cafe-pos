import { eq } from 'drizzle-orm';
import { io, type Socket } from 'socket.io-client';
import * as schema from '../src/database/schema';
import { NAMESPACES } from '../src/realtime/realtime.constants';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * §17's Phase 5 exit criterion: *two browser KDS tabs + a fake kiosk see events
 * < 2 s*, and the NFR behind it (realtime latency under two seconds).
 *
 * Two app instances, because that is the shape §11.3 commits to and the only
 * shape in which the Redis adapter does anything. Every other suite in this
 * phase would pass identically with the adapter deleted — a screen connected to
 * the only running process hears its own broadcasts whether or not they went
 * through Redis. What is under test here is the wiring nothing else touches:
 * an event raised on the instance that took the HTTP request reaching a socket
 * held by the instance that did not.
 *
 * The two-second budget is asserted rather than assumed. It is a *product*
 * requirement — a barista works from this board — so a change that leaves
 * delivery working but slow should fail here rather than be noticed in a shop.
 */
describe('Realtime across two instances (e2e)', () => {
  /** Serves the HTTP requests. */
  let writer: IdentityHarness;
  /** Holds the sockets, and never sees a request that causes an event. */
  let reader: IdentityHarness;

  /**
   * Three logins for the whole suite, and the frugality is deliberate.
   *
   * §10.2's login limit is 20 per fifteen minutes **per source address**, and
   * every suite in the run shares one — so a spendthrift fixture does not fail
   * itself, it fails whichever suite happens to log in last. This one boots two
   * apps and was minting six before that arithmetic was checked.
   *
   * `adminToken` does double duty (catalog fixtures and the deactivation), and
   * both KDS tabs share `baristaToken` — which is also the most literal reading
   * of §17's "two browser KDS tabs": one person, two tabs.
   */
  let adminToken: string;
  let baristaToken: string;
  let croissantId: string;

  const NFR_LATENCY_MS = 2000;

  const openOn = (
    harness: IdentityHarness,
    namespace: string,
    options: Record<string, unknown> = {},
  ): Socket =>
    io(`${harness.url()}${namespace}`, {
      transports: ['websocket'],
      reconnection: false,
      ...options,
    });

  const connected = async (socket: Socket): Promise<Socket> => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('never connected')),
        4000,
      );
      socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return socket;
  };

  /** Resolves with the payload and how long it took to arrive. */
  const timedEvent = (
    socket: Socket,
    name: string,
  ): Promise<{ payload: Record<string, unknown>; ms: number }> => {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${name} within ${NFR_LATENCY_MS * 2}ms`)),
        NFR_LATENCY_MS * 2,
      );
      socket.once(name, (payload: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve({ payload, ms: Date.now() - startedAt });
      });
    });
  };

  beforeAll(async () => {
    writer = await IdentityHarness.boot();
    reader = await IdentityHarness.boot();

    // Minted on `writer`, presented to `reader`. Nothing about a staff token is
    // instance-local — it verifies against a signature — and a token that only
    // worked where it was issued would make the rest of this suite meaningless.
    adminToken = await writer.tokenFor('ADMIN');
    baristaToken = await writer.tokenFor('BARISTA');

    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await writer
        .http()
        .post(path)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);
      if (res.status !== 201) {
        throw new Error(`fixture ${path} failed with ${res.status}`);
      }
      return (res.body as { id: string }).id;
    };

    const categoryId = await post('/api/v1/categories', {
      name: `Cluster pastries ${Date.now()}`,
      sortOrder: 0,
    });
    croissantId = await post('/api/v1/items', {
      categoryId,
      name: `Cluster croissant ${Date.now()}`,
      basePriceMinor: 2000,
      sortOrder: 0,
    });
  });

  afterAll(async () => {
    try {
      await reader.close();
    } finally {
      await writer.close();
    }
  });

  /** A PAID order placed through `writer`, owned by a kiosk device. */
  const paidOrderFrom = async (
    deviceToken: string,
  ): Promise<{ id: string; orderNumber: string }> => {
    const res = await writer
      .http()
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        channel: 'KIOSK',
        customerName: 'Mei',
        items: [{ menuItemId: croissantId, quantity: 1, optionIds: [] }],
      });
    expect(res.status).toBe(201);
    const order = res.body as { id: string; orderNumber: string };

    await writer.db
      .update(schema.orders)
      .set({ status: 'PAID', expiresAt: null })
      .where(eq(schema.orders.id, order.id));

    return order;
  };

  const move = (orderId: string, to: string) =>
    writer
      .http()
      .post(`/api/v1/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${baristaToken}`)
      .send({ to });

  /**
   * The criterion itself. Two KDS screens — one on each instance — and a kiosk
   * on the instance that serves no requests, all watching an order move on the
   * other one.
   */
  it('reaches two KDS tabs and a kiosk within the latency budget', async () => {
    const device = await writer.createDevice('ACTIVE');
    const order = await paidOrderFrom(device.token);

    const localTab = await connected(
      openOn(writer, NAMESPACES.kds, { auth: { token: baristaToken } }),
    );
    const remoteTab = await connected(
      openOn(reader, NAMESPACES.kds, { auth: { token: baristaToken } }),
    );
    const kiosk = await connected(
      openOn(reader, NAMESPACES.kiosk, { auth: { token: device.token } }),
    );

    await move(order.id, 'IN_PREPARATION');

    const waiting = Promise.all([
      timedEvent(localTab, 'order.ready'),
      timedEvent(remoteTab, 'order.ready'),
      timedEvent(kiosk, 'order.ready'),
    ]);

    expect((await move(order.id, 'READY')).status).toBe(200);
    const [local, remote, forCustomer] = await waiting;

    for (const seen of [local, remote, forCustomer]) {
      expect(seen.payload).toMatchObject({ id: order.id, status: 'READY' });
      expect(seen.ms).toBeLessThan(NFR_LATENCY_MS);
    }

    localTab.disconnect();
    remoteTab.disconnect();
    kiosk.disconnect();
  });

  /**
   * The public board crosses instances too, and it is the one audience whose
   * payload is a whole list rather than the order that changed — so a broadcast
   * that arrived but carried the *sending* instance's view would show here.
   */
  it('rebuilds the public board on the instance that saw no request', async () => {
    const device = await writer.createDevice('ACTIVE');
    const order = await paidOrderFrom(device.token);

    const screen = await connected(openOn(reader, NAMESPACES.board));

    await move(order.id, 'IN_PREPARATION');
    const { payload, ms } = await timedEvent(screen, 'board.updated');

    expect(ms).toBeLessThan(NFR_LATENCY_MS);
    expect(payload as unknown as { orderNumber: string }[]).toEqual(
      expect.arrayContaining([
        { orderNumber: order.orderNumber, status: 'IN_PREPARATION' },
      ]),
    );

    screen.disconnect();
  });

  /**
   * Revocation is the other thing that has to cross the boundary, and it fails
   * differently: a missed *event* costs a screen one refresh, while a missed
   * *kill* leaves a fired employee watching the board from the instance nobody
   * revoked them on.
   *
   * Note this one does **not** exercise the Socket.IO adapter, and measurably
   * so: with the adapter removed from the harness the two tests above fail and
   * this one still passes. It travels on `RevocationSubscriber`'s own channel,
   * where every instance subscribes directly and cuts the sockets it holds.
   * That is the design, not an accident — but it means this test is evidence
   * about the kill channel and not about clustering, and nobody should read it
   * as covering both.
   */
  it('cuts a socket held by the other instance', async () => {
    const staff = await writer.createStaff('BARISTA');
    const token = await writer.tokenForUserId(staff.id, staff.role);

    const socket = await connected(
      openOn(reader, NAMESPACES.kds, { auth: { token } }),
    );

    const dropped = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), NFR_LATENCY_MS * 2);
      socket.on('disconnect', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    // Deactivating through `writer` — the instance that does not hold the
    // socket — is the whole point.
    const res = await writer
      .http()
      .patch(`/api/v1/users/${staff.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);

    await expect(dropped).resolves.toBe(true);
  });
});
