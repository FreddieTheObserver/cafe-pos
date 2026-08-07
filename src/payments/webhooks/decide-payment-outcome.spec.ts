import type { GatewayOutcome } from '../provider/payment-provider';
import {
  decidePaymentOutcome,
  type OrderRecord,
  type PaymentRecord,
} from './decide-payment-outcome';

const INTENT = 'pi_1';

const payment = (over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  id: 'pay_1',
  orderId: 'ord_1',
  amountMinor: 12_500,
  currency: 'THB',
  status: 'PENDING',
  ...over,
});

const order = (over: Partial<OrderRecord> = {}): OrderRecord => ({
  id: 'ord_1',
  status: 'PENDING_PAYMENT',
  ...over,
});

const succeeded = (
  over: Partial<Extract<GatewayOutcome, { kind: 'SUCCEEDED' }>> = {},
): GatewayOutcome => ({
  kind: 'SUCCEEDED',
  intentId: INTENT,
  amountMinor: 12_500,
  currency: 'THB',
  ...over,
});

describe('decidePaymentOutcome', () => {
  describe('a payment that succeeded', () => {
    it('marks the order paid when everything agrees', () => {
      expect(decidePaymentOutcome(succeeded(), payment(), order())).toEqual({
        kind: 'MARK_PAID',
        paymentId: 'pay_1',
        orderId: 'ord_1',
      });
    });

    /**
     * The amount is checked, never trusted — the reason `GatewayOutcome`
     * carries it at all. They can disagree only if something is wrong, and
     * marking an order PAID is the one move in this system that cannot be
     * undone: refunds are bookkeeping against the till, so there is no
     * software path back.
     */
    it('refuses when the gateway reports a different amount', () => {
      const decision = decidePaymentOutcome(
        succeeded({ amountMinor: 1 }),
        payment(),
        order(),
      );

      expect(decision.kind).toBe('REFUSE');
    });

    it('refuses when the gateway reports a different currency', () => {
      const decision = decidePaymentOutcome(
        succeeded({ currency: 'USD' }),
        payment(),
        order(),
      );

      expect(decision.kind).toBe('REFUSE');
    });

    /**
     * An event naming an intent we have no row for. Not necessarily an attack
     * — a create that timed out after Stripe had already opened the intent
     * would do it — but it is never something to act on blindly.
     */
    it('refuses when no payment row matches the intent', () => {
      const decision = decidePaymentOutcome(succeeded(), undefined, order());

      expect(decision.kind).toBe('REFUSE');
    });

    /**
     * Idempotency at the decision level. A redelivery that got past the inbox,
     * or a replay after a processing bug, must not transition an order that is
     * already where the event would put it.
     */
    it('skips an order that is already paid', () => {
      const decision = decidePaymentOutcome(
        succeeded(),
        payment({ status: 'SUCCEEDED' }),
        order({ status: 'PAID' }),
      );

      expect(decision.kind).toBe('SKIP');
    });

    /**
     * EXPIRED is terminal (§4.4), and the expiry sweep is meant to close this
     * race at the source by cancelling the intent first — leaving the order in
     * PENDING_PAYMENT when Stripe answers ALREADY_SUCCEEDED. So money arriving
     * for an EXPIRED order means that did not happen, which is a fault worth a
     * human rather than a state machine quietly reopening a closed order.
     */
    it('refuses an order that has already expired', () => {
      const decision = decidePaymentOutcome(
        succeeded(),
        payment(),
        order({ status: 'EXPIRED' }),
      );

      expect(decision.kind).toBe('REFUSE');
    });

    it('refuses an order that was cancelled', () => {
      const decision = decidePaymentOutcome(
        succeeded(),
        payment(),
        order({ status: 'CANCELLED' }),
      );

      expect(decision.kind).toBe('REFUSE');
    });

    it('refuses when the payment names an order that is gone', () => {
      const decision = decidePaymentOutcome(succeeded(), payment(), undefined);

      expect(decision.kind).toBe('REFUSE');
    });
  });

  describe('a payment that did not succeed', () => {
    /**
     * The order stays PENDING_PAYMENT. A declined card is not the end of the
     * order — the customer is still standing there and can try another rail,
     * which is exactly what B4's "one live payment" rule leaves room for once
     * this row is terminal.
     */
    it('records a failure against the payment without moving the order', () => {
      const decision = decidePaymentOutcome(
        { kind: 'FAILED', intentId: INTENT, reason: 'declined' },
        payment(),
        order(),
      );

      expect(decision).toEqual({
        kind: 'MARK_PAYMENT',
        paymentId: 'pay_1',
        status: 'FAILED',
      });
    });

    it('records a cancellation against the payment', () => {
      const decision = decidePaymentOutcome(
        { kind: 'CANCELLED', intentId: INTENT },
        payment(),
        order(),
      );

      expect(decision).toEqual({
        kind: 'MARK_PAYMENT',
        paymentId: 'pay_1',
        status: 'CANCELLED',
      });
    });

    /** Replay safety: a payment already in that state is nothing to do. */
    it('skips a payment already recorded as failed', () => {
      const decision = decidePaymentOutcome(
        { kind: 'FAILED', intentId: INTENT, reason: null },
        payment({ status: 'FAILED' }),
        order(),
      );

      expect(decision.kind).toBe('SKIP');
    });

    /**
     * A failure for an intent whose payment succeeded is contradictory, and
     * the safe reading is that our SUCCEEDED is right and this is noise
     * arriving late — but not something to silently overwrite money with.
     */
    it('refuses to fail a payment that already succeeded', () => {
      const decision = decidePaymentOutcome(
        { kind: 'FAILED', intentId: INTENT, reason: null },
        payment({ status: 'SUCCEEDED' }),
        order({ status: 'PAID' }),
      );

      expect(decision.kind).toBe('REFUSE');
    });
  });

  /**
   * Stripe emits dozens of types this system does not act on. They are stored
   * for the audit trail and marked processed — not refused, or the sweep would
   * carry them forever.
   */
  it('skips an event it does not act on', () => {
    const decision = decidePaymentOutcome(
      { kind: 'IGNORED' },
      undefined,
      undefined,
    );

    expect(decision.kind).toBe('SKIP');
  });
});
