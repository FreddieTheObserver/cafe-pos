import type { OrderStatus, PaymentStatus } from '../../database/schema/enums';
import type { GatewayOutcome } from '../provider/payment-provider';

/** Our own side of the payment — the record the gateway is checked against. */
export interface PaymentRecord {
  id: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
}

export interface OrderRecord {
  id: string;
  status: OrderStatus;
}

/**
 * What to do about one inbox row.
 *
 * `SKIP` and `REFUSE` both mean "change nothing", and the difference is what
 * happens to the row afterwards: a skipped event is marked processed and
 * forgotten, a refused one keeps `processed_at` NULL so the sweep keeps
 * surfacing it until a human resolves it. Collapsing them into one case would
 * make "nothing to do here" indistinguishable from "something is wrong and
 * nobody has looked at it yet".
 */
export type PaymentDecision =
  | { kind: 'MARK_PAID'; paymentId: string; orderId: string }
  | { kind: 'MARK_PAYMENT'; paymentId: string; status: PaymentStatus }
  | { kind: 'SKIP'; why: string }
  | { kind: 'REFUSE'; why: string };

/** Payment states no later event may move — money has already been decided. */
const SETTLED: readonly PaymentStatus[] = ['SUCCEEDED'];

/**
 * Decides what one gateway event means for our rows — and nothing else.
 *
 * Pure on purpose. Every branch here is a decision about money, and the ones
 * that matter most (a mismatched amount, a late success against an order that
 * has already gone) are precisely the ones that are miserable to reach through
 * a database. Keeping the judgement separate from the writing means each case
 * is one function call in a test rather than a fixture.
 */
export function decidePaymentOutcome(
  outcome: GatewayOutcome,
  payment: PaymentRecord | undefined,
  order: OrderRecord | undefined,
): PaymentDecision {
  if (outcome.kind === 'IGNORED') {
    return { kind: 'SKIP', why: 'Event type is not one this system acts on.' };
  }

  if (payment === undefined) {
    return {
      kind: 'REFUSE',
      why: `No payment row for intent ${outcome.intentId}.`,
    };
  }

  if (outcome.kind === 'SUCCEEDED') {
    return decideSuccess(outcome, payment, order);
  }

  const status: PaymentStatus =
    outcome.kind === 'FAILED' ? 'FAILED' : 'CANCELLED';

  if (payment.status === status) {
    return { kind: 'SKIP', why: `Payment is already ${status}.` };
  }

  /**
   * A late failure for a payment that succeeded. Contradictory, and the only
   * safe reading is that the success is the truth — but overwriting a settled
   * payment on the strength of a contradiction is exactly the kind of silent
   * money bug the inbox exists to make visible.
   */
  if (SETTLED.includes(payment.status)) {
    return {
      kind: 'REFUSE',
      why: `Gateway reports ${outcome.kind} for a payment already ${payment.status}.`,
    };
  }

  return { kind: 'MARK_PAYMENT', paymentId: payment.id, status };
}

function decideSuccess(
  outcome: Extract<GatewayOutcome, { kind: 'SUCCEEDED' }>,
  payment: PaymentRecord,
  order: OrderRecord | undefined,
): PaymentDecision {
  // Checked against our own row, never trusted (§12.4). The one place a
  // disagreement must be caught is before an order is marked PAID.
  if (payment.amountMinor !== outcome.amountMinor) {
    return {
      kind: 'REFUSE',
      why: `Gateway captured ${outcome.amountMinor} but the payment is for ${payment.amountMinor}.`,
    };
  }

  if (payment.currency !== outcome.currency) {
    return {
      kind: 'REFUSE',
      why: `Gateway captured ${outcome.currency} but the payment is in ${payment.currency}.`,
    };
  }

  if (order === undefined) {
    return {
      kind: 'REFUSE',
      why: `Payment ${payment.id} names order ${payment.orderId}, which does not exist.`,
    };
  }

  // Already applied — a redelivery that got past the inbox, or a replay.
  if (order.status === 'PAID') {
    return { kind: 'SKIP', why: 'Order is already PAID.' };
  }

  /**
   * §4.4 gives PAID exactly one source, and the expiry sweep is meant to keep
   * it that way: it cancels the intent before expiring an order, and leaves the
   * order in PENDING_PAYMENT when the gateway answers ALREADY_SUCCEEDED. Money
   * arriving for an order in any other state means that did not happen, and a
   * terminal order quietly reopening is worse than a human being told.
   */
  if (order.status !== 'PENDING_PAYMENT') {
    return {
      kind: 'REFUSE',
      why: `Gateway reports payment for order ${order.id}, which is ${order.status}.`,
    };
  }

  return { kind: 'MARK_PAID', paymentId: payment.id, orderId: order.id };
}
