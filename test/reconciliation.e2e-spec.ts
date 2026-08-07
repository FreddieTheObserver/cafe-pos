import { inArray } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import type { PaymentStatus } from '../src/database/schema/enums';
import { ReconciliationService } from '../src/payments/reconciliation/reconciliation.service';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * FR-20's gateway-versus-books check, and §11.3's `reconciliation_delta_minor`.
 *
 * The gateway is faked rather than called, because the interesting cases are
 * the ones where Stripe and the books *disagree* — and the only way to produce
 * a disagreement against real Stripe would be to corrupt our own rows, which
 * would test the corruption rather than the check.
 */
describe('Reconciliation (e2e)', () => {
  const AMOUNT = 12_500;

  /** What the fake gateway will claim it captured, keyed by intent id. */
  const captured = new Map<string, number>();
  let gatewayReachable = true;

  const provider = {
    capturedTotalFor: (intentIds: readonly string[]) => {
      if (!gatewayReachable) {
        return Promise.reject(new Error('Stripe is unreachable'));
      }

      let totalMinor = 0;
      const notCaptured: string[] = [];
      for (const id of intentIds) {
        const amount = captured.get(id);
        if (amount === undefined) notCaptured.push(id);
        else totalMinor += amount;
      }
      return Promise.resolve({ totalMinor, notCaptured });
    },
  };

  let harness: IdentityHarness;
  let reconciliation: ReconciliationService;
  let cashierId: string;

  /**
   * A business day of its own per test.
   *
   * Reconciliation sums *every* payment for a day, so tests sharing one would
   * accumulate into each other's totals — which would be the job working
   * correctly and the fixture being wrong. A synthetic day per test isolates
   * them without needing to clean up in between.
   */
  let day: string;
  let dayCounter = 0;

  const orderIds: string[] = [];
  const eventIds: string[] = [];

  async function givenStripePayment({
    businessDay = day,
    status = 'SUCCEEDED',
    amountMinor = AMOUNT,
    gatewaySays = amountMinor,
  }: {
    businessDay?: string;
    status?: PaymentStatus;
    amountMinor?: number;
    gatewaySays?: number | null;
  } = {}): Promise<string> {
    const orderId = uuidv7();
    const intentId = `pi_recon_${uuidv7()}`;
    orderIds.push(orderId);

    await harness.db.insert(schema.orders).values({
      id: orderId,
      businessDay,
      channel: 'COUNTER',
      createdByUserId: cashierId,
      status: 'PAID',
      subtotalMinor: amountMinor,
      vatMinor: 0,
      totalMinor: amountMinor,
      currency: 'THB',
    });

    await harness.db.insert(schema.payments).values({
      orderId,
      provider: 'STRIPE',
      providerIntentId: intentId,
      status,
      amountMinor,
      currency: 'THB',
    });

    if (gatewaySays !== null) captured.set(intentId, gatewaySays);
    return intentId;
  }

  async function givenCashPayment(amountMinor: number): Promise<void> {
    const orderId = uuidv7();
    orderIds.push(orderId);

    await harness.db.insert(schema.orders).values({
      id: orderId,
      businessDay: day,
      channel: 'COUNTER',
      createdByUserId: cashierId,
      status: 'PAID',
      subtotalMinor: amountMinor,
      vatMinor: 0,
      totalMinor: amountMinor,
      currency: 'THB',
    });
    await harness.db.insert(schema.payments).values({
      orderId,
      provider: 'CASH',
      method: 'CASH',
      status: 'SUCCEEDED',
      amountMinor,
      currency: 'THB',
      cashTenderedMinor: amountMinor,
    });
  }

  beforeAll(async () => {
    harness = await IdentityHarness.boot({ paymentProvider: provider });
    reconciliation = harness.app.get(ReconciliationService);
    cashierId = (await harness.createStaff('CASHIER')).id;
  }, 60_000);

  beforeEach(() => {
    gatewayReachable = true;
    dayCounter += 1;
    day = `2030-01-${String(dayCounter).padStart(2, '0')}`;
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

  it('reports a zero delta when the gateway agrees with the books', async () => {
    await givenStripePayment();
    await givenStripePayment();

    const report = await reconciliation.reconcile(day);

    expect(report.dbRecordedMinor).toBe(AMOUNT * 2);
    expect(report.gatewayCapturedMinor).toBe(AMOUNT * 2);
    expect(report.deltaMinor).toBe(0);
  });

  /** The case the whole job exists for (§11.3: page a human). */
  it('reports the delta when the gateway captured a different amount', async () => {
    await givenStripePayment({ amountMinor: 10_000, gatewaySays: 9_000 });

    const report = await reconciliation.reconcile(day);

    expect(report.deltaMinor).toBe(-1_000);
  });

  /** Cash never touches the gateway, so counting it would invent a delta. */
  it('ignores cash payments', async () => {
    await givenStripePayment({ amountMinor: 10_000 });
    await givenCashPayment(50_000);

    const report = await reconciliation.reconcile(day);

    expect(report.dbRecordedMinor).toBe(10_000);
    expect(report.deltaMinor).toBe(0);
  });

  /** An attempt both sides agree failed is not a disagreement. */
  it('ignores payments that never succeeded', async () => {
    await givenStripePayment({
      amountMinor: 10_000,
      status: 'FAILED',
      gatewaySays: null,
    });

    const report = await reconciliation.reconcile(day);

    expect(report.dbRecordedMinor).toBe(0);
    expect(report.deltaMinor).toBe(0);
  });

  it('reconciles one business day at a time', async () => {
    await givenStripePayment({ amountMinor: 10_000 });
    await givenStripePayment({
      businessDay: '2020-01-01',
      amountMinor: 77_000,
    });

    const report = await reconciliation.reconcile(day);

    expect(report.dbRecordedMinor).toBe(10_000);
  });

  /** We say it was paid; the gateway does not. A real disagreement, named. */
  it('names intents the gateway does not report as captured', async () => {
    const intentId = await givenStripePayment({
      amountMinor: 10_000,
      gatewaySays: null,
    });

    const report = await reconciliation.reconcile(day);

    expect(report.notCaptured).toContain(intentId);
    expect(report.deltaMinor).toBe(-10_000);
  });

  /**
   * The other direction of the same question: an event this system refused to
   * act on keeps `processed_at` NULL precisely so it surfaces here.
   */
  it('surfaces inbox rows nothing ever processed', async () => {
    const providerEventId = `evt_recon_${uuidv7()}`;
    eventIds.push(providerEventId);
    await harness.db.insert(schema.paymentEvents).values({
      providerEventId,
      eventType: 'payment_intent.succeeded',
      payload: { id: providerEventId, object: 'event' },
    });

    const report = await reconciliation.reconcile(day);

    expect(report.unmatchedEvents).toContain(providerEventId);
  });

  /**
   * "We could not check" and "we checked and it agrees" are opposite facts. A
   * job reporting a delta of zero when the gateway was unreachable would be
   * worse than one that did not run at all.
   */
  it('reports nothing rather than a false zero when the gateway is unreachable', async () => {
    await givenStripePayment();
    gatewayReachable = false;

    await expect(reconciliation.reconcile(day)).rejects.toThrow();
    // The nightly wrapper turns that into a logged failure, not a report.
    expect(await reconciliation.reconcileYesterday()).toBeNull();
  });
});
