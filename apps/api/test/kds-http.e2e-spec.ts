import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { IdentityHarness } from './fixtures/identity-fixtures';

interface KdsTicketBody {
  id: string;
  orderNumber: string | null;
  status: string;
  customerName: string | null;
  createdAt: string;
  items: {
    nameSnapshot: string;
    quantity: number;
    notes: string | null;
    options: { group: string; name: string; priceDeltaMinor: number }[];
  }[];
}

/**
 * `GET /kds/orders` (§5.2, §17 Phase 5).
 *
 * The board is a worklist, so what matters here is less "does it return rows"
 * than *which* rows and in what order — a barista working from a board that
 * silently omits a paid ticket, or shows them newest first, makes the wrong
 * drink next.
 */
describe('KDS snapshot endpoint (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;
  let baristaToken: string;
  let kioskToken: string;

  let croissantId: string;

  const auth = (token: string) => `Bearer ${token}`;

  const board = (token: string) =>
    harness.http().get('/api/v1/kds/orders').set('Authorization', auth(token));

  const post = async (
    path: string,
    body: Record<string, unknown>,
  ): Promise<string> => {
    const res = await harness
      .http()
      .post(path)
      .set('Authorization', auth(managerToken))
      .send(body);
    if (res.status !== 201) {
      throw new Error(
        `fixture ${path} failed with ${res.status}: ${JSON.stringify(res.body)}`,
      );
    }
    return (res.body as { id: string }).id;
  };

  /** An order parked directly at `status` — §4.4 leaves no endpoint to PAID. */
  const orderAt = async (
    status: 'PAID' | 'IN_PREPARATION' | 'READY' | 'COMPLETED' | 'CANCELLED',
    notes: string | null = null,
  ): Promise<string> => {
    const res = await harness
      .http()
      .post('/api/v1/orders')
      .set('Authorization', auth(kioskToken))
      .send({
        channel: 'KIOSK',
        customerName: 'Mei',
        items: [{ menuItemId: croissantId, quantity: 2, notes, optionIds: [] }],
      });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;

    await harness.db
      .update(schema.orders)
      .set({ status, expiresAt: null })
      .where(eq(schema.orders.id, id));

    return id;
  };

  const ticketsFrom = (body: unknown) => body as KdsTicketBody[];

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    managerToken = await harness.accessTokenFor('MANAGER');
    baristaToken = await harness.accessTokenFor('BARISTA');
    const device = await harness.createDevice('ACTIVE');
    kioskToken = device.token;

    const categoryId = await post('/api/v1/categories', {
      name: `KDS pastries ${uuidv7()}`,
      sortOrder: 0,
    });
    croissantId = await post('/api/v1/items', {
      categoryId,
      name: `Butter croissant ${uuidv7()}`,
      basePriceMinor: 2000,
      sortOrder: 0,
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('shows a barista the tickets that still have to be made', async () => {
    const paid = await orderAt('PAID');
    const preparing = await orderAt('IN_PREPARATION');
    const ready = await orderAt('READY');

    const res = await board(baristaToken);

    expect(res.status).toBe(200);
    const ids = ticketsFrom(res.body).map((ticket) => ticket.id);
    expect(ids).toEqual(expect.arrayContaining([paid, preparing, ready]));
  });

  /**
   * The board is a worklist, not a history. A collected drink lingering on it
   * is how a barista makes the same order twice.
   */
  it('drops orders that have left the kitchen', async () => {
    const completed = await orderAt('COMPLETED');
    const cancelled = await orderAt('CANCELLED');

    const ids = ticketsFrom((await board(baristaToken)).body).map((t) => t.id);

    expect(ids).not.toContain(completed);
    expect(ids).not.toContain(cancelled);
  });

  /**
   * Oldest first — the drink that has waited longest is made next.
   *
   * Asserted on the *relative* order of this test's own tickets rather than on
   * the whole board. The board is global, so an exact-array assertion would be
   * a claim about every other suite's leftovers as much as about sorting, and
   * would pass or fail on how clean the database happened to be.
   */
  it('queues the oldest ticket first', async () => {
    const first = await orderAt('PAID');
    const second = await orderAt('PAID');
    const third = await orderAt('PAID');
    const mine = [first, second, third];

    const ids = ticketsFrom((await board(baristaToken)).body)
      .map((ticket) => ticket.id)
      .filter((id) => mine.includes(id));

    expect(ids).toEqual(mine);
  });

  /**
   * A ticket without its lines is not a ticket — the barista cannot make the
   * drink from a queue number.
   */
  it('carries the lines, options and notes needed to make the drink', async () => {
    const id = await orderAt('PAID', 'extra hot');

    const ticket = ticketsFrom((await board(baristaToken)).body).find(
      (candidate) => candidate.id === id,
    );

    expect(ticket).toBeDefined();
    expect(ticket?.customerName).toBe('Mei');
    expect(ticket?.items).toHaveLength(1);
    expect(ticket?.items[0]).toMatchObject({
      nameSnapshot: expect.stringContaining('Butter croissant') as string,
      quantity: 2,
      notes: 'extra hot',
    });
  });

  it('is never cached', async () => {
    const res = await board(baristaToken);

    expect(res.headers['cache-control']).toBe('no-store');
  });

  /**
   * §6.4: a kiosk is a tablet in a public space. It has no business holding a
   * list of everything the cafe is making.
   */
  it('refuses a kiosk device token', async () => {
    const res = await board(kioskToken);

    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await harness.http().get('/api/v1/kds/orders');

    expect(res.status).toBe(401);
  });
});
