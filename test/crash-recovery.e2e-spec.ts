import { eq, inArray } from 'drizzle-orm';
import Stripe from 'stripe';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { STRIPE_WEBHOOK_SECRETS } from '../src/payments/payments.constants';
import type { PaymentProvider } from '../src/payments/provider/payment-provider';
import { StripePaymentProvider } from '../src/payments/provider/stripe-payment.provider';
import { PaymentEventProcessor } from '../src/payments/webhooks/payment-event-processor.service';
import { IdentityHarness } from './fixtures/identity-fixtures';

const ENDPOINT = '/api/v1/webhooks/stripe';
const TOTAL = 12_500;

/**
 * §17's Phase 4 exit criterion: "crash-recovery test green", and the
 * reliability NFR it comes from — *any process may die between any two steps
 * and the system reconciles via webhooks/jobs*.
 *
 * The step that matters is the one the inbox exists for: between acking Stripe
 * and applying what the event meant. Stripe has been told 200 by then, so it
 * will never redeliver, and the row on disk is the only remaining copy. If the
 * process dies there and nothing recovers it, a customer has paid for a coffee
 * no barista will ever see.
 *
 * Two app instances, because that is the real shape of the thing (§11.3): the
 * one that took the delivery is not the one that finishes it, and they
 * coordinate through nothing but the row.
 */
describe('Crash recovery (e2e)', () => {
  const orderIds: string[] = [];
  const eventIds: string[] = [];

  let dying: IdentityHarness;
  let survivor: IdentityHarness;
  let stripe: Stripe;
  let secret: string;
  let cashierId: string;

  /**
   * Verifies for real, then dies the moment it tries to interpret.
   *
   * `parseWebhook` delegates to the genuine adapter so the ack path is the
   * production one — signature and all — and `interpret` throws, which is where
   * processing begins. That reproduces a process lost after the row is
   * committed and before anything is done about it, without needing to kill a
   * node.
   */
  function crashingProvider(webhookSecret: string): Partial<PaymentProvider> {
    const real = new StripePaymentProvider(
      new Stripe('sk_test_notarealkey', { apiVersion: '2026-07-29.dahlia' }),
      [webhookSecret],
    );

    return {
      parseWebhook: (rawBody: Buffer, signature: string) =>
        real.parseWebhook(rawBody, signature),
      interpret: () => {
        throw new Error('process died before it could interpret the event');
      },
    };
  }

  async function givenOrderAwaitingPayment(): Promise<{
    orderId: string;
    intentId: string;
  }> {
    const orderId = uuidv7();
    const intentId = `pi_crash_${uuidv7()}`;
    orderIds.push(orderId);

    await survivor.db.insert(schema.orders).values({
      id: orderId,
      businessDay: '2026-08-07',
      channel: 'COUNTER',
      createdByUserId: cashierId,
      status: 'PENDING_PAYMENT',
      subtotalMinor: 11_682,
      vatMinor: 818,
      totalMinor: TOTAL,
      currency: 'THB',
    });

    await survivor.db.insert(schema.payments).values({
      orderId,
      provider: 'STRIPE',
      providerIntentId: intentId,
      status: 'PENDING',
      amountMinor: TOTAL,
      currency: 'THB',
    });

    return { orderId, intentId };
  }

  function eventBody(eventId: string, intentId: string): string {
    return JSON.stringify({
      id: eventId,
      object: 'event',
      type: 'payment_intent.succeeded',
      api_version: '2026-07-29.dahlia',
      created: 1_785_829_150,
      data: {
        object: { id: intentId, amount_received: TOTAL, currency: 'thb' },
      },
    });
  }

  const orderStatusOf = async (orderId: string) =>
    (
      await survivor.db.query.orders.findFirst({
        where: eq(schema.orders.id, orderId),
        columns: { status: true },
      })
    )?.status;

  beforeAll(async () => {
    // Booted first so its config supplies the secret the crasher must verify
    // against — both instances are the same deployment, not two configurations.
    survivor = await IdentityHarness.boot();
    secret = survivor.app.get<readonly string[]>(STRIPE_WEBHOOK_SECRETS)[0];
    stripe = new Stripe('sk_test_notarealkey', {
      apiVersion: '2026-07-29.dahlia',
    });
    cashierId = (await survivor.createStaff('CASHIER')).id;

    dying = await IdentityHarness.boot({
      paymentProvider: crashingProvider(secret),
    });
  }, 90_000);

  afterAll(async () => {
    if (eventIds.length > 0) {
      await survivor.db
        .delete(schema.paymentEvents)
        .where(inArray(schema.paymentEvents.providerEventId, eventIds));
    }
    if (orderIds.length > 0) {
      await survivor.db
        .delete(schema.payments)
        .where(inArray(schema.payments.orderId, orderIds));
      await survivor.db
        .delete(schema.orderStatusHistory)
        .where(inArray(schema.orderStatusHistory.orderId, orderIds));
      await survivor.db
        .delete(schema.orders)
        .where(inArray(schema.orders.id, orderIds));
    }
    await dying.close();
    await survivor.close();
  });

  it('recovers a payment whose handler died after acking Stripe', async () => {
    const { orderId, intentId } = await givenOrderAwaitingPayment();
    const providerEventId = `evt_crash_${uuidv7()}`;
    eventIds.push(providerEventId);
    const body = eventBody(providerEventId, intentId);

    /**
     * The delivery Stripe will never repeat. A 2xx is a promise that we have
     * the event, and everything after this point is ours to finish.
     */
    const ack = await dying
      .http()
      .post(ENDPOINT)
      .set(
        'stripe-signature',
        stripe.webhooks.generateTestHeaderString({ payload: body, secret }),
      )
      .set('content-type', 'application/json')
      .send(body);

    expect(ack.status).toBe(200);

    // The crash left the row on disk and the order untouched — no half-applied
    // state, which is the other half of what makes recovery safe.
    const stored = await survivor.db.query.paymentEvents.findFirst({
      where: eq(schema.paymentEvents.providerEventId, providerEventId),
    });
    expect(stored).toBeDefined();
    expect(stored?.processedAt).toBeNull();
    expect(await orderStatusOf(orderId)).toBe('PENDING_PAYMENT');

    // A different instance, sharing nothing but the database, finishes the job.
    await survivor.app.get(PaymentEventProcessor).drainInbox();

    expect(await orderStatusOf(orderId)).toBe('PAID');
    const recovered = await survivor.db.query.paymentEvents.findFirst({
      where: eq(schema.paymentEvents.providerEventId, providerEventId),
    });
    expect(recovered?.processedAt).not.toBeNull();
  });

  /**
   * The crash must not cost the customer their money *or* charge them twice.
   * Recovery is a replay, and a replay that ran twice would transition an
   * already-PAID order — which the guarded update refuses, silently and by
   * design.
   */
  it('recovers exactly once, however many sweeps run', async () => {
    const { orderId, intentId } = await givenOrderAwaitingPayment();
    const providerEventId = `evt_crash_${uuidv7()}`;
    eventIds.push(providerEventId);
    const body = eventBody(providerEventId, intentId);

    await dying
      .http()
      .post(ENDPOINT)
      .set(
        'stripe-signature',
        stripe.webhooks.generateTestHeaderString({ payload: body, secret }),
      )
      .set('content-type', 'application/json')
      .send(body);

    const processor = survivor.app.get(PaymentEventProcessor);
    // Both instances sweeping at once is the steady state, not an edge case.
    await Promise.all([processor.drainInbox(), processor.drainInbox()]);
    await processor.drainInbox();

    expect(await orderStatusOf(orderId)).toBe('PAID');

    const history = await survivor.db
      .select()
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, orderId));
    expect(history).toHaveLength(1);
  });
});
