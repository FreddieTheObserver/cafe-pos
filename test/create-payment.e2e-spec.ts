import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import * as schema from '../src/database/schema';
import type { OrderStatus } from '../src/database/schema/enums';
import { IdentityHarness } from './fixtures/identity-fixtures';

const TOTAL = 12_500;

interface PaymentBody {
  id: string;
  status: string;
  method: string | null;
  amountMinor: number;
  currency: string;
  provider: string;
  clientAction: { type: string; clientSecret?: string } | null;
}

/**
 * `POST /orders/:id/payments` (FR-11, §5.2, B4, B6).
 *
 * Gateway cases talk to Stripe in test mode, so they open real test-mode
 * PaymentIntents — the same thing the kiosk will do, and the only way to prove
 * the client secret this route hands out is one Stripe would actually accept.
 */
describe('Create payment endpoint (e2e)', () => {
  let harness: IdentityHarness;
  let cashierToken: string;
  let cashierId: string;
  let kioskToken: string;
  let kioskDeviceId: string;

  const orderIds: string[] = [];

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;
  const paymentOf = (res: { body: unknown }): PaymentBody =>
    res.body as PaymentBody;

  /** An order ready to be paid, owned by the kiosk unless told otherwise. */
  async function givenOrder({
    status = 'PENDING_PAYMENT',
    ownedByKiosk = true,
  }: { status?: OrderStatus; ownedByKiosk?: boolean } = {}): Promise<string> {
    const id = uuidv7();
    orderIds.push(id);

    await harness.db.insert(schema.orders).values({
      id,
      businessDay: '2026-08-07',
      channel: ownedByKiosk ? 'KIOSK' : 'COUNTER',
      kioskDeviceId: ownedByKiosk ? kioskDeviceId : null,
      createdByUserId: ownedByKiosk ? null : cashierId,
      status,
      subtotalMinor: 11_682,
      vatMinor: 818,
      totalMinor: TOTAL,
      currency: 'THB',
    });

    return id;
  }

  const pay = (orderId: string, token: string, body: object) =>
    harness
      .http()
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const orderStatusOf = async (orderId: string) =>
    (
      await harness.db.query.orders.findFirst({
        where: eq(schema.orders.id, orderId),
        columns: { status: true },
      })
    )?.status;

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    cashierToken = await harness.accessTokenFor('CASHIER');
    cashierId = (await harness.createStaff('CASHIER')).id;
    const device = await harness.createDevice('ACTIVE');
    kioskToken = device.token;
    kioskDeviceId = device.id;
  }, 60_000);

  afterAll(async () => {
    if (orderIds.length > 0) {
      await harness.db
        .delete(schema.payments)
        .where(inArray(schema.payments.orderId, orderIds));
      await harness.db
        .delete(schema.orderStatusHistory)
        .where(inArray(schema.orderStatusHistory.orderId, orderIds));
      await harness.db
        .delete(schema.orders)
        .where(inArray(schema.orders.id, orderIds));
    }
    await harness.close();
  });

  describe('cash at the counter', () => {
    it('settles immediately and pays the order', async () => {
      const orderId = await givenOrder({ ownedByKiosk: false });

      const res = await pay(orderId, cashierToken, {
        method: 'CASH',
        cashTenderedMinor: 20_000,
      });

      expect(res.status).toBe(201);
      expect(paymentOf(res)).toMatchObject({
        status: 'SUCCEEDED',
        method: 'CASH',
        provider: 'CASH',
        amountMinor: TOTAL,
        clientAction: null,
      });
      // No webhook is coming; the money is in the drawer.
      expect(await orderStatusOf(orderId)).toBe('PAID');
    });

    /** B6: there is no drawer at a kiosk, and nobody standing at it. */
    it('refuses a kiosk taking cash', async () => {
      const orderId = await givenOrder();

      const res = await pay(orderId, kioskToken, {
        method: 'CASH',
        cashTenderedMinor: 20_000,
      });

      expect(res.status).toBe(403);
      expect(problemOf(res).code).toBe('FORBIDDEN_ROLE');
      expect(await orderStatusOf(orderId)).toBe('PENDING_PAYMENT');
    });

    /**
     * 422 with its own code, not a reused ORDER_NOT_PAYABLE. The order is in
     * exactly the right state — the money is short — and the response has to
     * say so, or a cashier reads "only a PENDING_PAYMENT order accepts a
     * payment" about an order that is PENDING_PAYMENT.
     */
    it('refuses a tender that does not cover the total', async () => {
      const orderId = await givenOrder({ ownedByKiosk: false });

      const res = await pay(orderId, cashierToken, {
        method: 'CASH',
        cashTenderedMinor: 100,
      });

      expect(res.status).toBe(422);
      expect(problemOf(res).code).toBe('CASH_TENDER_INSUFFICIENT');
      expect(problemOf(res).meta).toMatchObject({ requiredMinor: TOTAL });
      expect(await orderStatusOf(orderId)).toBe('PENDING_PAYMENT');
    });

    it('refuses CASH with no tender at all', async () => {
      const orderId = await givenOrder({ ownedByKiosk: false });

      const res = await pay(orderId, cashierToken, { method: 'CASH' });

      expect(res.status).toBe(422);
    });
  });

  describe('a gateway payment', () => {
    it('opens an intent and hands back a client secret', async () => {
      const orderId = await givenOrder();

      const res = await pay(orderId, kioskToken, { method: 'CARD' });

      expect(res.status).toBe(201);
      const payment = paymentOf(res);
      expect(payment.status).toBe('PENDING');
      expect(payment.provider).toBe('STRIPE');
      expect(payment.clientAction?.type).toBe('CONFIRM_WITH_CLIENT_SECRET');
      expect(payment.clientAction?.clientSecret).toMatch(/^pi_.+_secret_.+/);

      /**
       * Null, and deliberately so. With dynamic payment methods the customer
       * picks the rail inside the Payment Element after this intent exists, so
       * nobody knows yet — §5.2's echo of the requested method describes a
       * design this gateway does not implement.
       */
      expect(payment.method).toBeNull();

      // The webhook is what moves it; nothing is paid yet.
      expect(await orderStatusOf(orderId)).toBe('PENDING_PAYMENT');
    }, 30_000);

    /** The client secret authorises confirming a payment (§10.5). */
    it('forbids caching the response', async () => {
      const orderId = await givenOrder();

      const res = await pay(orderId, kioskToken, { method: 'PROMPTPAY' });

      expect(res.headers['cache-control']).toBe('no-store');
    }, 30_000);

    it('rejects a cash tender sent with a gateway method', async () => {
      const orderId = await givenOrder();

      const res = await pay(orderId, kioskToken, {
        method: 'CARD',
        cashTenderedMinor: 20_000,
      });

      expect(res.status).toBe(422);
    });
  });

  describe('refusals', () => {
    /** B4, enforced by `one_live_payment` as well as by this check. */
    it('refuses a second live payment for the same order', async () => {
      const orderId = await givenOrder();
      const first = await pay(orderId, kioskToken, { method: 'CARD' });
      expect(first.status).toBe(201);

      const second = await pay(orderId, kioskToken, { method: 'CARD' });

      expect(second.status).toBe(409);
      expect(problemOf(second).code).toBe('PAYMENT_ALREADY_ACTIVE');
    }, 30_000);

    it('refuses an order that is not awaiting payment', async () => {
      const orderId = await givenOrder({
        status: 'DRAFT',
        ownedByKiosk: false,
      });

      const res = await pay(orderId, cashierToken, {
        method: 'CASH',
        cashTenderedMinor: 20_000,
      });

      expect(res.status).toBe(409);
      expect(problemOf(res).code).toBe('ORDER_NOT_PAYABLE');
    });

    it('tells an expired order apart from a merely unpayable one', async () => {
      const orderId = await givenOrder({ status: 'EXPIRED' });

      const res = await pay(orderId, kioskToken, { method: 'CARD' });

      expect(res.status).toBe(409);
      expect(problemOf(res).code).toBe('ORDER_EXPIRED');
    });

    /**
     * 404 rather than 403 (§6.4). A kiosk asking about someone else's order
     * learns only that it has no such order — a 403 would confirm the id
     * exists, which is an enumeration oracle for a token in an unattended
     * machine.
     */
    it('hides another principal’s order from a kiosk', async () => {
      const orderId = await givenOrder({ ownedByKiosk: false });

      const res = await pay(orderId, kioskToken, { method: 'CARD' });

      expect(res.status).toBe(404);
    });
  });

  describe('listing the attempts', () => {
    it('returns the payments behind an order, oldest first', async () => {
      const orderId = await givenOrder({ ownedByKiosk: false });
      await pay(orderId, cashierToken, {
        method: 'CASH',
        cashTenderedMinor: 20_000,
      });

      const res = await harness
        .http()
        .get(`/api/v1/orders/${orderId}/payments`)
        .set('Authorization', `Bearer ${cashierToken}`);

      expect(res.status).toBe(200);
      const attempts = res.body as PaymentBody[];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        status: 'SUCCEEDED',
        method: 'CASH',
        provider: 'CASH',
      });
    });

    /** The secret authorises confirming a payment; it is served once, never again. */
    it('never re-serves a client secret', async () => {
      const orderId = await givenOrder();
      await pay(orderId, kioskToken, { method: 'CARD' });

      const res = await harness
        .http()
        .get(`/api/v1/orders/${orderId}/payments`)
        .set('Authorization', `Bearer ${kioskToken}`);

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('_secret_');
    }, 30_000);

    it('hides another principal’s order from a kiosk', async () => {
      const orderId = await givenOrder({ ownedByKiosk: false });

      const res = await harness
        .http()
        .get(`/api/v1/orders/${orderId}/payments`)
        .set('Authorization', `Bearer ${kioskToken}`);

      expect(res.status).toBe(404);
    });
  });

  /**
   * §5.7: the kiosk retries a request it never saw answered, and must get the
   * original payment rather than a second one against the same basket.
   */
  it('replays a repeated Idempotency-Key instead of paying twice', async () => {
    const orderId = await givenOrder({ ownedByKiosk: false });
    const key = `key-${uuidv7()}`;
    const body = { method: 'CASH', cashTenderedMinor: 20_000 };

    const first = await harness
      .http()
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', key)
      .send(body);
    const second = await harness
      .http()
      .post(`/api/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Idempotency-Key', key)
      .send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(paymentOf(second).id).toBe(paymentOf(first).id);
    expect(second.headers['idempotent-replay']).toBe('true');

    const rows = await harness.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.orderId, orderId));
    expect(rows).toHaveLength(1);
  });
});
