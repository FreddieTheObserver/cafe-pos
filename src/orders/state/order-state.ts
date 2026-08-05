import type { OrderStatus } from '../../database/schema/enums';

/**
 * The §4.4 state machine, as data.
 *
 * One table rather than a scatter of `if (status === …)` checks across the
 * services that move orders, because by Phase 4 there are four such doors — a
 * webhook, a manager's refund, the expiry job, and the KDS route below — and
 * the only way they can agree about what an order may do next is to be asking
 * the same object.
 *
 * The prose rules §4.4 adds are visible here too. `PAID` appears exactly once,
 * as a target of `PENDING_PAYMENT`: an order becomes paid because a payment
 * succeeded, never because an endpoint said so. And a partial refund is absent
 * entirely — it leaves the order where it is and attaches a refund record, so
 * `REFUNDED` means *fully* refunded.
 */
export const ORDER_TRANSITIONS = {
  /** Counter-only: a basket parked while the customer decides. */
  DRAFT: ['PENDING_PAYMENT', 'CANCELLED'],
  PENDING_PAYMENT: ['PAID', 'EXPIRED', 'CANCELLED'],
  PAID: ['IN_PREPARATION', 'REFUNDED'],
  IN_PREPARATION: ['READY', 'REFUNDED'],
  READY: ['COMPLETED', 'REFUNDED'],
  /** Same business day only — the window is policy (§3.3), not structure. */
  COMPLETED: ['REFUNDED'],
  CANCELLED: [],
  EXPIRED: [],
  REFUNDED: [],
} as const satisfies Record<OrderStatus, readonly OrderStatus[]>;

/** Where an order stops. Kept explicit so the tests can hold the table to it. */
export const TERMINAL_STATUSES = [
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
] as const satisfies readonly OrderStatus[];

export const isLegalTransition = (
  from: OrderStatus,
  to: OrderStatus,
): boolean => (ORDER_TRANSITIONS[from] as readonly OrderStatus[]).includes(to);

/**
 * What `POST /orders/:id/status` exposes — the KDS path and nothing else
 * (§5.2, §6.4).
 *
 * Deliberately narrower than the machine. Every other edge belongs to a door
 * with its own rules: payment to the gateway webhook, refunds to a manager,
 * expiry to a background job, cancellation to its own endpoint with its own
 * authorization. Without this second table a barista holding the status route
 * could mark an order paid, and the guarded update would happily let them.
 */
export const STAFF_TRANSITIONS = [
  ['PAID', 'IN_PREPARATION'],
  ['IN_PREPARATION', 'READY'],
  ['READY', 'COMPLETED'],
] as const satisfies readonly (readonly [OrderStatus, OrderStatus])[];

export const isStaffTransition = (
  from: OrderStatus,
  to: OrderStatus,
): boolean =>
  STAFF_TRANSITIONS.some(
    ([source, target]) => source === from && target === to,
  );
