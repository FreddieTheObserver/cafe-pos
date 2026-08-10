import { eq } from 'drizzle-orm';
import { io, type Socket } from 'socket.io-client';
import * as schema from '../src/database/schema';
import { NAMESPACES } from '../src/realtime/realtime.constants';
import { IdentityHarness } from './fixtures/identity-fixtures';

interface BoardEntryBody {
  orderNumber: string;
  status: string;
}

/**
 * The public board (§5.2) — REST snapshot and `board` namespace.
 *
 * The only unauthenticated surface in the system, so the tests that matter are
 * the negative ones: that it is reachable with no credential at all, and that
 * reaching it yields nothing but queue numbers.
 */
describe('Public board (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;
  let croissantId: string;

  const board = () => harness.http().get('/api/v1/orders/board');
  const entriesFrom = (body: unknown) => body as BoardEntryBody[];

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

  /** An order sitting at `status`, with a customer name attached. */
  const orderAt = async (
    status: 'PAID' | 'IN_PREPARATION' | 'READY' | 'COMPLETED',
  ): Promise<{ id: string; orderNumber: string }> => {
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
    const created = res.body as { id: string; orderNumber: string };

    await harness.db
      .update(schema.orders)
      .set({ status, expiresAt: null })
      .where(eq(schema.orders.id, created.id));

    return created;
  };

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    managerToken = await harness.accessTokenFor('MANAGER');

    const categoryId = await post('/api/v1/categories', {
      name: `Board pastries ${Date.now()}`,
      sortOrder: 0,
    });
    croissantId = await post('/api/v1/items', {
      categoryId,
      name: `Board croissant ${Date.now()}`,
      basePriceMinor: 2000,
      sortOrder: 0,
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('is readable with no credentials at all', async () => {
    const res = await board();

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  /**
   * The route exists at all only because it is registered before
   * `GET /orders/:id`. Reordering the modules makes this 422 — "board" is not
   * a UUID — so this is the test that catches it.
   */
  it('is not swallowed by the order-detail route', async () => {
    const res = await board();

    expect(res.status).not.toBe(422);
    expect(res.status).not.toBe(401);
  });

  it('shows orders being prepared and ready for collection', async () => {
    const preparing = await orderAt('IN_PREPARATION');
    const ready = await orderAt('READY');

    const numbers = entriesFrom((await board()).body).map((e) => e.orderNumber);

    expect(numbers).toContain(preparing.orderNumber);
    expect(numbers).toContain(ready.orderNumber);
  });

  /**
   * §5.2 says preparing and ready. A paid order has not been started, and a
   * collected one is gone — neither is something a waiting customer can act on.
   */
  it('hides orders that are not yet started or already collected', async () => {
    const paid = await orderAt('PAID');
    const collected = await orderAt('COMPLETED');

    const numbers = entriesFrom((await board()).body).map((e) => e.orderNumber);

    expect(numbers).not.toContain(paid.orderNumber);
    expect(numbers).not.toContain(collected.orderNumber);
  });

  /**
   * The property this whole audience exists under. §3.3.5 makes the customer's
   * name the only PII the system holds, and this is the one surface anybody on
   * the street can read — so the assertion is on the *whole serialised body*,
   * not on named fields, because a leak would arrive as a field nobody thought
   * to check.
   */
  it('carries nothing but queue numbers and states', async () => {
    await orderAt('READY');

    const res = await board();
    const raw = JSON.stringify(res.body);

    expect(raw).not.toContain('Mei');
    expect(raw).not.toContain('customerName');
    expect(raw).not.toContain('totalMinor');
    expect(raw).not.toContain('items');

    for (const entry of entriesFrom(res.body)) {
      expect(Object.keys(entry).sort()).toEqual(['orderNumber', 'status']);
    }
  });

  it('is never cached', async () => {
    expect((await board()).headers['cache-control']).toBe('no-store');
  });

  it('pushes the whole board to an anonymous socket when an order moves', async () => {
    const socket: Socket = io(`${harness.url()}${NAMESPACES.board}`, {
      transports: ['websocket'],
      reconnection: false,
    });

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

    const order = await orderAt('IN_PREPARATION');

    const arrived = new Promise<BoardEntryBody[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no board.updated within 4000ms')),
        4000,
      );
      socket.once('board.updated', (payload: BoardEntryBody[]) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

    // Any move recomputes the list; READY is the one a customer waits for.
    const res = await harness
      .http()
      .post(`/api/v1/orders/${order.id}/status`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ to: 'READY' });
    expect(res.status).toBe(200);

    const entries = await arrived;
    expect(entries).toEqual(
      expect.arrayContaining([
        { orderNumber: order.orderNumber, status: 'READY' },
      ]),
    );

    socket.disconnect();
  });
});
