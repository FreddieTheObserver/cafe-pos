import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { OrderExpiryService } from '../src/orders/expiry/order-expiry.service';
import type { CancelIntentOutcome } from '../src/payments/provider/payment-provider';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * E3: the sweep asks the gateway before it reclaims an order.
 *
 * The whole point of `CancelIntentOutcome` being a value rather than an
 * exception. A customer scanning the QR at 9:59 and a sweep firing at 10:00 are
 * both behaving correctly, and only Stripe knows which won — so the sweep's
 * behaviour is a function of the gateway's answer, and the only way to test
 * both branches is to control it.
 *
 * This is also what makes the inbox's "refuse a success against an EXPIRED
 * order" branch defensive rather than load-bearing: with this in place, the
 * race that would produce one is closed at the source.
 */
describe('Order expiry cancels the intent (e2e)', () => {
  const orderIds: string[] = [];

  let cancelOutcome: CancelIntentOutcome = 'CANCELLED';
  const cancelled: string[] = [];

  /** Stands in for Stripe so both answers are reachable without confirming a payment. */
  const provider = {
    cancelIntent: (intentId: string): Promise<CancelIntentOutcome> => {
      cancelled.push(intentId);
      return Promise.resolve(cancelOutcome);
    },
  };

  let harness: IdentityHarness;
  let cashierId: string;

  async function givenOverdueOrder(): Promise<{
    orderId: string;
    paymentId: string;
    intentId: string;
  }> {
    const orderId = uuidv7();
    const intentId = `pi_expiry_${uuidv7()}`;
    orderIds.push(orderId);

    await harness.db.insert(schema.orders).values({
      id: orderId,
      businessDay: '2026-08-07',
      channel: 'COUNTER',
      createdByUserId: cashierId,
      status: 'PENDING_PAYMENT',
      subtotalMinor: 11_682,
      vatMinor: 818,
      totalMinor: 12_500,
      currency: 'THB',
      // Already past: the sweep's WHERE is `expires_at < now()`.
      expiresAt: new Date(Date.now() - 60_000),
    });

    const [payment] = await harness.db
      .insert(schema.payments)
      .values({
        orderId,
        provider: 'STRIPE',
        providerIntentId: intentId,
        status: 'PENDING',
        amountMinor: 12_500,
        currency: 'THB',
      })
      .returning({ id: schema.payments.id });

    return { orderId, paymentId: payment.id, intentId };
  }

  const orderStatusOf = async (orderId: string) =>
    (
      await harness.db.query.orders.findFirst({
        where: eq(schema.orders.id, orderId),
        columns: { status: true },
      })
    )?.status;

  const paymentStatusOf = async (paymentId: string) =>
    (
      await harness.db.query.payments.findFirst({
        where: eq(schema.payments.id, paymentId),
        columns: { status: true },
      })
    )?.status;

  let cashierToken: string;

  beforeAll(async () => {
    harness = await IdentityHarness.boot({ paymentProvider: provider });
    cashierId = (await harness.createStaff('CASHIER')).id;
    cashierToken = await harness.accessTokenFor('CASHIER');
  }, 60_000);

  beforeEach(() => {
    cancelOutcome = 'CANCELLED';
    cancelled.length = 0;
  });

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

  it('cancels the intent behind an order it reclaims', async () => {
    const { orderId, paymentId, intentId } = await givenOverdueOrder();

    await harness.app.get(OrderExpiryService).expireOverdue();

    expect(cancelled).toContain(intentId);
    expect(await orderStatusOf(orderId)).toBe('EXPIRED');
    // Not left live, or B4 would block the customer from ever ordering again.
    expect(await paymentStatusOf(paymentId)).toBe('CANCELLED');
  });

  /**
   * The race, resolved the only way that does not strand money: the customer
   * paid in the last second, so the order is *not* expired and stays in
   * PENDING_PAYMENT for the webhook to mark PAID through the ordinary door.
   */
  it('leaves an order alone when its payment already succeeded', async () => {
    const { orderId, paymentId, intentId } = await givenOverdueOrder();
    cancelOutcome = 'ALREADY_SUCCEEDED';

    await harness.app.get(OrderExpiryService).expireOverdue();

    expect(cancelled).toContain(intentId);
    expect(await orderStatusOf(orderId)).toBe('PENDING_PAYMENT');
    // Still live: the webhook is about to settle it.
    expect(await paymentStatusOf(paymentId)).toBe('PENDING');
  });

  /**
   * The *other* door out of PENDING_PAYMENT, and the one the first pass of this
   * work missed. `POST /orders/:id/cancel` reaches the same state the expiry
   * sweep does, so it needs the same handling — otherwise a customer who scans
   * the QR, changes their mind and taps cancel leaves a live intent they can
   * still pay, and the webhook then finds a CANCELLED order and refuses. Money
   * captured, no order to fulfil, and only the nightly reconciliation to notice.
   */
  describe('cancelling an order', () => {
    const cancel = (orderId: string) =>
      harness
        .http()
        .post(`/api/v1/orders/${orderId}/cancel`)
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ reason: 'Customer changed their mind' });

    it('cancels the intent behind the order it is cancelling', async () => {
      const { orderId, paymentId, intentId } = await givenOverdueOrder();

      const res = await cancel(orderId);

      expect(res.status).toBe(200);
      expect(cancelled).toContain(intentId);
      expect(await orderStatusOf(orderId)).toBe('CANCELLED');
      expect(await paymentStatusOf(paymentId)).toBe('CANCELLED');
    });

    /** Lost the race: the customer confirmed while the cancel was in flight. */
    it('refuses to cancel an order whose payment already succeeded', async () => {
      const { orderId, paymentId } = await givenOverdueOrder();
      cancelOutcome = 'ALREADY_SUCCEEDED';

      const res = await cancel(orderId);

      expect(res.status).toBe(409);
      expect((res.body as { code: string }).code).toBe('ORDER_ALREADY_PAID');
      // Left alone for the webhook to mark PAID through the ordinary door.
      expect(await orderStatusOf(orderId)).toBe('PENDING_PAYMENT');
      expect(await paymentStatusOf(paymentId)).toBe('PENDING');
    });
  });

  /** And it stays reclaimable — the next tick tries again, and the one after. */
  it('reclaims the order once the webhook has not come after all', async () => {
    const { orderId } = await givenOverdueOrder();
    cancelOutcome = 'ALREADY_SUCCEEDED';
    await harness.app.get(OrderExpiryService).expireOverdue();
    expect(await orderStatusOf(orderId)).toBe('PENDING_PAYMENT');

    cancelOutcome = 'CANCELLED';
    await harness.app.get(OrderExpiryService).expireOverdue();

    expect(await orderStatusOf(orderId)).toBe('EXPIRED');
  });
});
