import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import * as schema from '../src/database/schema';
import type { OrderStatus, PaymentStatus } from '../src/database/schema/enums';
import { businessDayOf } from '../src/orders/business-day';
import {
  completeKey,
  keyExpiry,
  reserveKey,
} from '../src/orders/idempotency/idempotency.store';
import { hashRequest } from '../src/orders/idempotency/request-hash';
import { IdentityHarness } from './fixtures/identity-fixtures';

const TOTAL = 12_500;

interface RefundBody {
  id: string;
  paymentId: string;
  amountMinor: number;
  status: string;
  fullyRefunded: boolean;
}

/**
 * `POST /payments/:id/refunds` (§5.2, §4.4, E9).
 *
 * No money moves through Stripe — refunds are settled from the till — but the
 * amounts are still policed, which is the whole point of these cases: E9's
 * arithmetic is a rule about the books, not about the gateway.
 */
describe('Refund endpoint (e2e)', () => {
  let harness: IdentityHarness;
  let managerToken: string;
  let cashierToken: string;
  let cashierId: string;
  let today: string;

  const orderIds: string[] = [];

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;
  const refundOf = (res: { body: unknown }): RefundBody =>
    res.body as RefundBody;

  async function givenPaidOrder({
    orderStatus = 'PAID',
    paymentStatus = 'SUCCEEDED',
    businessDay = today,
  }: {
    orderStatus?: OrderStatus;
    paymentStatus?: PaymentStatus;
    businessDay?: string;
  } = {}): Promise<{ orderId: string; paymentId: string }> {
    const orderId = uuidv7();
    orderIds.push(orderId);

    await harness.db.insert(schema.orders).values({
      id: orderId,
      businessDay,
      channel: 'COUNTER',
      createdByUserId: cashierId,
      status: orderStatus,
      subtotalMinor: 11_682,
      vatMinor: 818,
      totalMinor: TOTAL,
      currency: 'THB',
    });

    const [payment] = await harness.db
      .insert(schema.payments)
      .values({
        orderId,
        provider: 'CASH',
        method: 'CASH',
        status: paymentStatus,
        amountMinor: TOTAL,
        currency: 'THB',
        cashTenderedMinor: TOTAL,
      })
      .returning({ id: schema.payments.id });

    return { orderId, paymentId: payment.id };
  }

  const refund = (paymentId: string, token: string, body: object) =>
    harness
      .http()
      .post(`/api/v1/payments/${paymentId}/refunds`)
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
    managerToken = await harness.tokenFor('MANAGER');
    cashierToken = await harness.tokenFor('CASHIER');
    cashierId = (await harness.createStaff('CASHIER')).id;
    today = businessDayOf(
      new Date(),
      process.env.BUSINESS_TIMEZONE ?? 'Asia/Bangkok',
      Number(process.env.BUSINESS_DAY_START_HOUR ?? 5),
    );
  }, 60_000);

  afterAll(async () => {
    if (orderIds.length > 0) {
      const paymentIds = (
        await harness.db
          .select({ id: schema.payments.id })
          .from(schema.payments)
          .where(inArray(schema.payments.orderId, orderIds))
      ).map((row) => row.id);

      if (paymentIds.length > 0) {
        await harness.db
          .delete(schema.refunds)
          .where(inArray(schema.refunds.paymentId, paymentIds));
      }
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

  it('refunds in full and moves the order to REFUNDED', async () => {
    const { orderId, paymentId } = await givenPaidOrder();

    const res = await refund(paymentId, managerToken, {
      amountMinor: TOTAL,
      reason: 'Wrong drink made',
    });

    expect(res.status).toBe(201);
    expect(refundOf(res)).toMatchObject({
      amountMinor: TOTAL,
      status: 'SUCCEEDED',
      fullyRefunded: true,
    });
    expect(await orderStatusOf(orderId)).toBe('REFUNDED');
  });

  /** No gateway refund happened, so there is no id to carry (§12.4). */
  it('records no provider refund id', async () => {
    const { paymentId } = await givenPaidOrder();

    await refund(paymentId, managerToken, {
      amountMinor: TOTAL,
      reason: 'Spilled',
    });

    const row = await harness.db.query.refunds.findFirst({
      where: eq(schema.refunds.paymentId, paymentId),
    });
    expect(row?.providerRefundId).toBeNull();
    expect(row?.initiatedByUserId).not.toBeNull();
  });

  /**
   * §4.4: a partial refund leaves the order where it is and attaches a record,
   * so REFUNDED means *fully* refunded.
   */
  it('leaves the order alone for a partial refund', async () => {
    const { orderId, paymentId } = await givenPaidOrder();

    const res = await refund(paymentId, managerToken, {
      amountMinor: 2_500,
      reason: 'Missing pastry',
    });

    expect(res.status).toBe(201);
    expect(refundOf(res).fullyRefunded).toBe(false);
    expect(await orderStatusOf(orderId)).toBe('PAID');
  });

  it('moves the order once partial refunds add up to the whole', async () => {
    const { orderId, paymentId } = await givenPaidOrder();

    await refund(paymentId, managerToken, {
      amountMinor: 10_000,
      reason: 'Most of it',
    });
    const last = await refund(paymentId, managerToken, {
      amountMinor: 2_500,
      reason: 'The rest',
    });

    expect(refundOf(last).fullyRefunded).toBe(true);
    expect(await orderStatusOf(orderId)).toBe('REFUNDED');
  });

  /** E9: `amount ≤ captured − already refunded`. */
  it('refuses to take back more than was captured', async () => {
    const { paymentId } = await givenPaidOrder();

    const res = await refund(paymentId, managerToken, {
      amountMinor: TOTAL + 1,
      reason: 'Too much',
    });

    expect(res.status).toBe(422);
    expect(problemOf(res).code).toBe('REFUND_EXCEEDS_REMAINING');
  });

  it('counts what is already refunded against the remainder', async () => {
    const { paymentId } = await givenPaidOrder();
    await refund(paymentId, managerToken, {
      amountMinor: 10_000,
      reason: 'First',
    });

    const res = await refund(paymentId, managerToken, {
      amountMinor: 5_000,
      reason: 'More than is left',
    });

    expect(res.status).toBe(422);
    expect(problemOf(res).code).toBe('REFUND_EXCEEDS_REMAINING');
    expect(problemOf(res).meta).toMatchObject({ remainingMinor: 2_500 });
  });

  it('refuses a payment that never captured anything', async () => {
    const { paymentId } = await givenPaidOrder({
      orderStatus: 'PENDING_PAYMENT',
      paymentStatus: 'FAILED',
    });

    const res = await refund(paymentId, managerToken, {
      amountMinor: 100,
      reason: 'Never paid',
    });

    expect(res.status).toBe(409);
    expect(problemOf(res).code).toBe('PAYMENT_NOT_REFUNDABLE');
  });

  /** §3.3: a till reconciled at close cannot be reopened by yesterday's refund. */
  it('refuses a refund against a closed business day', async () => {
    const { paymentId } = await givenPaidOrder({ businessDay: '2020-01-01' });

    const res = await refund(paymentId, managerToken, {
      amountMinor: 100,
      reason: 'Too late',
    });

    expect(res.status).toBe(409);
    expect(problemOf(res).code).toBe('PAYMENT_NOT_REFUNDABLE');
  });

  /** §6.4: the one money route a cashier cannot reach. */
  it('refuses a cashier', async () => {
    const { paymentId } = await givenPaidOrder();

    const res = await refund(paymentId, cashierToken, {
      amountMinor: 100,
      reason: 'Not mine to give',
    });

    expect(res.status).toBe(403);
    expect(problemOf(res).code).toBe('FORBIDDEN_ROLE');
  });

  it('requires a reason', async () => {
    const { paymentId } = await givenPaidOrder();

    const res = await refund(paymentId, managerToken, { amountMinor: 100 });

    expect(res.status).toBe(422);
  });

  describe('with an Idempotency-Key', () => {
    const body = { amountMinor: 2_500, reason: 'Missing pastry' };

    const refundWithKey = (
      paymentId: string,
      token: string,
      key: string,
      payload: object = body,
    ) => refund(paymentId, token, payload).set('Idempotency-Key', key);

    const refundRows = (paymentId: string) =>
      harness.db
        .select()
        .from(schema.refunds)
        .where(eq(schema.refunds.paymentId, paymentId));

    it('replays a retried refund instead of recording a second one', async () => {
      const { paymentId } = await givenPaidOrder();
      const key = `key-${uuidv7()}`;

      const first = await refundWithKey(paymentId, managerToken, key);
      const second = await refundWithKey(paymentId, managerToken, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(refundOf(second).id).toBe(refundOf(first).id);
      expect(first.headers['idempotency-replayed']).toBeUndefined();
      expect(second.headers['idempotency-replayed']).toBe('true');
      expect(await refundRows(paymentId)).toHaveLength(1);
    });

    it('replays a retried full refund instead of refusing it', async () => {
      const { orderId, paymentId } = await givenPaidOrder();
      const key = `key-${uuidv7()}`;
      const full = { amountMinor: TOTAL, reason: 'Wrong drink made' };

      const first = await refundWithKey(paymentId, managerToken, key, full);
      const second = await refundWithKey(paymentId, managerToken, key, full);

      expect(second.status).toBe(201);
      expect(refundOf(second)).toMatchObject({
        id: refundOf(first).id,
        fullyRefunded: true,
      });
      expect(await orderStatusOf(orderId)).toBe('REFUNDED');
    });

    it('replays a retry that arrives after the business day closed', async () => {
      const { orderId, paymentId } = await givenPaidOrder();
      const key = `key-${uuidv7()}`;
      const first = await refundWithKey(paymentId, managerToken, key);
      await harness.db
        .update(schema.orders)
        .set({ businessDay: '2020-01-01' })
        .where(eq(schema.orders.id, orderId));

      const second = await refundWithKey(paymentId, managerToken, key);

      expect(second.status).toBe(201);
      expect(refundOf(second).id).toBe(refundOf(first).id);
      expect(second.headers['idempotency-replayed']).toBe('true');
    });

    class RolledBack extends Error {}

    /**
     * Holds a reservation open in a transaction of the test's own, which is the
     * state a retry sees while the original request is still running.
     */
    async function holdReservation(
      key: string,
      requestHash: string,
      finish: (tx: Parameters<typeof reserveKey>[0]) => Promise<void>,
    ) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let markReserved!: () => void;
      const reserved = new Promise<void>((resolve) => (markReserved = resolve));

      const original = harness.db
        .transaction(async (tx) => {
          await reserveKey(tx, key, requestHash, keyExpiry());
          markReserved();
          await released;
          await finish(tx);
        })
        .catch((error: unknown) => {
          if (!(error instanceof RolledBack)) throw error;
        });
      await reserved;

      return { release, original };
    }

    it('waits for an original still in flight, then replays its answer', async () => {
      const staff = await harness.createStaff('MANAGER');
      const token = await harness.tokenForUserId(staff.id, 'MANAGER');
      const { paymentId } = await givenPaidOrder();
      const key = `key-${uuidv7()}`;
      const stored = {
        id: uuidv7(),
        paymentId,
        ...body,
        status: 'SUCCEEDED',
        fullyRefunded: false,
      };
      const { release, original } = await holdReservation(
        key,
        hashRequest(`user:${staff.id}:refunds:${paymentId}`, body),
        (tx) => completeKey(tx, key, 201, stored),
      );

      let answered = false;
      const retry = refundWithKey(paymentId, token, key).then((res) => {
        answered = true;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(answered).toBe(false);

      release();
      await original;
      const res = await retry;

      expect(res.status).toBe(201);
      expect(refundOf(res).id).toBe(stored.id);
      expect(res.headers['idempotency-replayed']).toBe('true');
      expect(await refundRows(paymentId)).toHaveLength(0);
    });

    it('does the work itself when the original in flight rolls back', async () => {
      const staff = await harness.createStaff('MANAGER');
      const token = await harness.tokenForUserId(staff.id, 'MANAGER');
      const { paymentId } = await givenPaidOrder();
      const key = `key-${uuidv7()}`;
      const { release, original } = await holdReservation(
        key,
        hashRequest(`user:${staff.id}:refunds:${paymentId}`, body),
        () => Promise.reject(new RolledBack()),
      );

      const retry = refundWithKey(paymentId, token, key);
      await new Promise((resolve) => setTimeout(resolve, 500));
      release();
      await original;
      const res = await retry;

      expect(res.status).toBe(201);
      expect(res.headers['idempotency-replayed']).toBeUndefined();
      expect(await refundRows(paymentId)).toHaveLength(1);
    });

    it('records one refund when the same request is sent twice at once', async () => {
      const { paymentId } = await givenPaidOrder();
      const key = `key-${uuidv7()}`;
      const send = () => refundWithKey(paymentId, managerToken, key);

      const [first, second] = await Promise.all([send(), send()]);

      expect([first.status, second.status]).toEqual([201, 201]);
      expect(refundOf(second).id).toBe(refundOf(first).id);
      expect(await refundRows(paymentId)).toHaveLength(1);
    });

    it('refuses the key for a different request', async () => {
      const { paymentId } = await givenPaidOrder();
      const key = `key-${uuidv7()}`;
      await refundWithKey(paymentId, managerToken, key);

      const res = await refundWithKey(paymentId, managerToken, key, {
        ...body,
        amountMinor: 1_000,
      });

      expect(res.status).toBe(409);
      expect(problemOf(res).code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await refundRows(paymentId)).toHaveLength(1);
    });

    it('does not let another manager replay the key', async () => {
      const { paymentId } = await givenPaidOrder();
      const key = `key-${uuidv7()}`;
      await refundWithKey(paymentId, managerToken, key);

      const res = await refundWithKey(
        paymentId,
        await harness.tokenFor('MANAGER'),
        key,
      );

      expect(res.status).toBe(409);
      expect(problemOf(res).code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await refundRows(paymentId)).toHaveLength(1);
    });

    it('leaves the key free after a refund that was refused', async () => {
      const { paymentId } = await givenPaidOrder();
      const key = `key-${uuidv7()}`;

      const refused = await refundWithKey(paymentId, managerToken, key, {
        ...body,
        amountMinor: TOTAL + 1,
      });
      const retried = await refundWithKey(paymentId, managerToken, key);

      expect(refused.status).toBe(422);
      expect(retried.status).toBe(201);
      expect(retried.headers['idempotency-replayed']).toBeUndefined();
    });

    it('refuses a malformed key', async () => {
      const { paymentId } = await givenPaidOrder();

      const res = await refundWithKey(paymentId, managerToken, 'short');

      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0].field).toBe('Idempotency-Key');
    });
  });
});
