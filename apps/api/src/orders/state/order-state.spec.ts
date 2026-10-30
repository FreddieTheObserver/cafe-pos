import { orderStatuses, type OrderStatus } from '../../database/schema/enums';
import {
  ORDER_TRANSITIONS,
  STAFF_TRANSITIONS,
  TERMINAL_STATUSES,
  isLegalTransition,
  isStaffTransition,
} from './order-state';

describe('the §4.4 order state machine', () => {
  it('has a rule for every status the schema allows', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual(
      [...orderStatuses].sort(),
    );
  });

  it('never names a target that is not a status', () => {
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      for (const target of targets) {
        expect(orderStatuses).toContain(target);
      }
    }
  });

  it('never lets a status transition to itself', () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      expect(targets).not.toContain(from as OrderStatus);
    }
  });

  describe('the happy path a cafe actually walks', () => {
    const path: OrderStatus[] = [
      'PENDING_PAYMENT',
      'PAID',
      'IN_PREPARATION',
      'READY',
      'COMPLETED',
    ];

    it.each(path.slice(0, -1).map((from, i) => [from, path[i + 1]]))(
      'allows %s -> %s',
      (from, to) => {
        expect(isLegalTransition(from, to)).toBe(true);
      },
    );
  });

  it('lets a counter park an order and check it out later', () => {
    expect(isLegalTransition('DRAFT', 'PENDING_PAYMENT')).toBe(true);
    expect(isLegalTransition('DRAFT', 'CANCELLED')).toBe(true);
  });

  it('lets an unpaid order expire or be cancelled', () => {
    expect(isLegalTransition('PENDING_PAYMENT', 'EXPIRED')).toBe(true);
    expect(isLegalTransition('PENDING_PAYMENT', 'CANCELLED')).toBe(true);
  });

  it('allows a refund from every state where money has been taken', () => {
    for (const from of [
      'PAID',
      'IN_PREPARATION',
      'READY',
      'COMPLETED',
    ] as OrderStatus[]) {
      expect(isLegalTransition(from, 'REFUNDED')).toBe(true);
    }
  });

  /** The rule §4.4 states in prose: no endpoint moves an order to PAID. */
  it('reaches PAID only from PENDING_PAYMENT', () => {
    const sources = orderStatuses.filter((from) =>
      isLegalTransition(from, 'PAID'),
    );

    expect(sources).toEqual(['PENDING_PAYMENT']);
  });

  it('never leaves a terminal state', () => {
    for (const status of TERMINAL_STATUSES) {
      expect(ORDER_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('agrees with itself about which states are terminal', () => {
    const dead = orderStatuses.filter(
      (status) => ORDER_TRANSITIONS[status].length === 0,
    );

    expect([...dead].sort()).toEqual([...TERMINAL_STATUSES].sort());
  });

  describe('transitions nobody may make', () => {
    const forbidden: [OrderStatus, OrderStatus][] = [
      // Money cannot un-happen.
      ['PAID', 'PENDING_PAYMENT'],
      ['READY', 'IN_PREPARATION'],
      ['COMPLETED', 'READY'],
      // Skipping the queue: an unpaid drink is not made.
      ['PENDING_PAYMENT', 'IN_PREPARATION'],
      ['PENDING_PAYMENT', 'READY'],
      ['PAID', 'COMPLETED'],
      // Terminal is terminal.
      ['CANCELLED', 'PENDING_PAYMENT'],
      ['EXPIRED', 'PAID'],
      ['REFUNDED', 'COMPLETED'],
    ];

    it.each(forbidden)('refuses %s -> %s', (from, to) => {
      expect(isLegalTransition(from, to)).toBe(false);
    });
  });
});

/**
 * §6.4 gives staff the three KDS moves and nothing else. Every other edge of
 * the graph belongs to a door with its own rules — payment to a webhook,
 * refunds to a manager, expiry to a job — and this is what keeps
 * `POST /orders/:id/status` from becoming a way to reach all of them.
 */
describe('the transitions staff may make through the status route', () => {
  it('covers the KDS path and nothing more', () => {
    expect(STAFF_TRANSITIONS).toEqual([
      ['PAID', 'IN_PREPARATION'],
      ['IN_PREPARATION', 'READY'],
      ['READY', 'COMPLETED'],
    ]);
  });

  it.each(STAFF_TRANSITIONS)('allows %s -> %s', (from, to) => {
    expect(isStaffTransition(from, to)).toBe(true);
  });

  it('is a subset of what the state machine permits', () => {
    for (const [from, to] of STAFF_TRANSITIONS) {
      expect(isLegalTransition(from, to)).toBe(true);
    }
  });

  /**
   * Legal in the graph, refused through this door. A barista holding the
   * status route must not be able to mark an order paid, refunded, or expired
   * — those are a webhook's, a manager's and a job's decisions.
   */
  it.each([
    ['PENDING_PAYMENT', 'PAID'],
    ['PENDING_PAYMENT', 'EXPIRED'],
    ['PENDING_PAYMENT', 'CANCELLED'],
    ['PAID', 'REFUNDED'],
    ['READY', 'REFUNDED'],
    ['COMPLETED', 'REFUNDED'],
    ['DRAFT', 'PENDING_PAYMENT'],
  ] as [OrderStatus, OrderStatus][])(
    'refuses %s -> %s even though the machine allows it',
    (from, to) => {
      expect(isLegalTransition(from, to)).toBe(true);
      expect(isStaffTransition(from, to)).toBe(false);
    },
  );
});
