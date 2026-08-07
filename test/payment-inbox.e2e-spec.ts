import { eq, inArray } from 'drizzle-orm';
import Stripe from 'stripe';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import type { OrderStatus } from '../src/database/schema/enums';
import { STRIPE_WEBHOOK_SECRETS } from '../src/payments/payments.constants';
import { PaymentEventProcessor } from '../src/payments/webhooks/payment-event-processor.service';
import { IdentityHarness } from './fixtures/identity-fixtures';

const ENDPOINT = '/api/v1/webhooks/stripe';
const TOTAL = 12_500;

/**
 * Draining the §4.2 inbox, against a real Postgres.
 *
 * The decision spec proves *what* each event means with pure inputs. This
 * proves the half that only a database can answer: that the guarded writes
 * actually land, that a refused event keeps `processed_at` NULL so the sweep
 * keeps surfacing it, and that replaying a drained row changes nothing.
 *
 * Orders and payments are inserted directly rather than driven through HTTP,
 * because the endpoint that opens a PaymentIntent does not exist yet. That is a
 * real gap in the coverage — these rows are shaped by hand — and it closes when
 * `POST /orders/:id/pay` lands and this file can build them the way the app
 * will.
 */
describe('Payment inbox processing (e2e)', () => {
  let harness: IdentityHarness;
  let processor: PaymentEventProcessor;
  let secret: string;
  let stripe: Stripe;

  const orderIds: string[] = [];
  const eventIds: string[] = [];

  /** `orders_actor_check`: every order is placed by a device or a staff user. */
  let cashierId: string;

  function eventBody(
    eventId: string,
    intentId: string,
    amount = TOTAL,
  ): string {
    return JSON.stringify({
      id: eventId,
      object: 'event',
      type: 'payment_intent.succeeded',
      api_version: '2026-07-29.dahlia',
      created: 1_785_829_150,
      data: {
        object: { id: intentId, amount_received: amount, currency: 'thb' },
      },
    });
  }

  /** An order in the given state with a live payment against it. */
  async function givenOrderAwaitingPayment(
    status: OrderStatus = 'PENDING_PAYMENT',
  ): Promise<{ orderId: string; paymentId: string; intentId: string }> {
    const orderId = uuidv7();
    const intentId = `pi_e2e_${uuidv7()}`;
    orderIds.push(orderId);

    await harness.db.insert(schema.orders).values({
      id: orderId,
      businessDay: '2026-08-07',
      channel: 'COUNTER',
      createdByUserId: cashierId,
      status,
      subtotalMinor: 11_682,
      vatMinor: 818,
      totalMinor: TOTAL,
      currency: 'THB',
    });

    const [payment] = await harness.db
      .insert(schema.payments)
      .values({
        orderId,
        provider: 'STRIPE',
        providerIntentId: intentId,
        status: 'PENDING',
        amountMinor: TOTAL,
        currency: 'THB',
      })
      .returning({ id: schema.payments.id });

    return { orderId, paymentId: payment.id, intentId };
  }

  /** Puts a verified event straight into the inbox, as the webhook would. */
  async function givenInboxEvent(
    intentId: string,
    amount = TOTAL,
  ): Promise<string> {
    const providerEventId = `evt_e2e_${uuidv7()}`;
    eventIds.push(providerEventId);

    const [row] = await harness.db
      .insert(schema.paymentEvents)
      .values({
        providerEventId,
        eventType: 'payment_intent.succeeded',
        payload: JSON.parse(eventBody(providerEventId, intentId, amount)),
      })
      .returning({ id: schema.paymentEvents.id });

    return row.id;
  }

  const orderStatusOf = async (orderId: string): Promise<string | undefined> =>
    (
      await harness.db.query.orders.findFirst({
        where: eq(schema.orders.id, orderId),
        columns: { status: true },
      })
    )?.status;

  const eventRow = async (rowId: string) =>
    harness.db.query.paymentEvents.findFirst({
      where: eq(schema.paymentEvents.id, rowId),
    });

  const paymentRow = async (paymentId: string) =>
    harness.db.query.payments.findFirst({
      where: eq(schema.payments.id, paymentId),
    });

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    processor = harness.app.get(PaymentEventProcessor);
    secret = harness.app.get<readonly string[]>(STRIPE_WEBHOOK_SECRETS)[0];
    stripe = new Stripe('sk_test_notarealkey', {
      apiVersion: '2026-07-29.dahlia',
    });
    cashierId = (await harness.createStaff('CASHIER')).id;
  });

  afterAll(async () => {
    if (eventIds.length > 0) {
      await harness.db
        .delete(schema.paymentEvents)
        .where(inArray(schema.paymentEvents.providerEventId, eventIds));
    }
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

  it('marks the order paid and stamps the inbox row', async () => {
    const { orderId, paymentId, intentId } = await givenOrderAwaitingPayment();
    const rowId = await givenInboxEvent(intentId);

    await processor.processEvent(rowId);

    expect(await orderStatusOf(orderId)).toBe('PAID');
    expect((await paymentRow(paymentId))?.status).toBe('SUCCEEDED');

    const row = await eventRow(rowId);
    expect(row?.processedAt).not.toBeNull();
    // Back-filled, so the audit trail links the event to what it was about.
    expect(row?.paymentId).toBe(paymentId);
  });

  /**
   * §4.4 clears `expires_at` on the way out of PENDING_PAYMENT. Left behind, a
   * KDS would render "expires in 3 minutes" on a drink already paid for.
   */
  it('records who moved the order, and stops it expiring', async () => {
    const { orderId, intentId } = await givenOrderAwaitingPayment();
    await harness.db
      .update(schema.orders)
      .set({ expiresAt: new Date(Date.now() + 600_000) })
      .where(eq(schema.orders.id, orderId));

    await processor.processEvent(await givenInboxEvent(intentId));

    const order = await harness.db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });
    expect(order?.expiresAt).toBeNull();

    const history = await harness.db.query.orderStatusHistory.findFirst({
      where: eq(schema.orderStatusHistory.orderId, orderId),
    });
    // The gateway said so, not a person (FR-22).
    expect(history?.actorType).toBe('SYSTEM');
    expect(history?.actorId).toBeNull();
    expect(history?.toStatus).toBe('PAID');
  });

  /**
   * The check that has to hold before an order is marked PAID. A refused event
   * keeps `processed_at` NULL on purpose — the sweep keeps surfacing it until a
   * human resolves it, which is the opposite of dropping it quietly.
   */
  it('refuses an amount that disagrees with our own row', async () => {
    const { orderId, paymentId, intentId } = await givenOrderAwaitingPayment();
    const rowId = await givenInboxEvent(intentId, 1);

    await processor.processEvent(rowId);

    expect(await orderStatusOf(orderId)).toBe('PENDING_PAYMENT');
    expect((await paymentRow(paymentId))?.status).toBe('PENDING');
    expect((await eventRow(rowId))?.processedAt).toBeNull();
  });

  /**
   * EXPIRED is terminal (§4.4). The expiry sweep is meant to close this race by
   * cancelling the intent first, so money arriving here means that did not
   * happen — a fault for a human, not a state machine reopening a closed order.
   */
  it('refuses to reopen an order that already expired', async () => {
    const { orderId, intentId } = await givenOrderAwaitingPayment('EXPIRED');
    const rowId = await givenInboxEvent(intentId);

    await processor.processEvent(rowId);

    expect(await orderStatusOf(orderId)).toBe('EXPIRED');
    expect((await eventRow(rowId))?.processedAt).toBeNull();
  });

  /** Replay safety: draining a row twice must not transition anything twice. */
  it('changes nothing when the same row is processed again', async () => {
    const { orderId, intentId } = await givenOrderAwaitingPayment();
    const rowId = await givenInboxEvent(intentId);

    expect(await processor.processEvent(rowId)).toBe(true);
    expect(await processor.processEvent(rowId)).toBe(false);

    expect(await orderStatusOf(orderId)).toBe('PAID');

    const history = await harness.db
      .select()
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, orderId));
    expect(history).toHaveLength(1);
  });

  /** The sweep is the backstop for anything the webhook's kick did not finish. */
  it('drains a row left behind by a crashed handler', async () => {
    const { orderId, intentId } = await givenOrderAwaitingPayment();
    await givenInboxEvent(intentId);

    await processor.drainInbox();

    expect(await orderStatusOf(orderId)).toBe('PAID');
  });

  /**
   * The whole path, over HTTP. The webhook kicks processing without awaiting
   * it, so this polls rather than asserting immediately — the ack is the
   * contract, and the transition follows it.
   */
  it('pays the order from a signed delivery, end to end', async () => {
    const { orderId, intentId } = await givenOrderAwaitingPayment();
    const providerEventId = `evt_e2e_${uuidv7()}`;
    eventIds.push(providerEventId);
    const body = eventBody(providerEventId, intentId);

    const response = await harness
      .http()
      .post(ENDPOINT)
      .set(
        'stripe-signature',
        stripe.webhooks.generateTestHeaderString({ payload: body, secret }),
      )
      .set('content-type', 'application/json')
      .send(body);

    expect(response.status).toBe(200);

    for (let i = 0; i < 50; i++) {
      if ((await orderStatusOf(orderId)) === 'PAID') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(await orderStatusOf(orderId)).toBe('PAID');
  });
});
