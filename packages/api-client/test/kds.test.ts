import { describe, expect, it } from 'vitest';
import {
  KDS_SNAPSHOT_LIMIT,
  applySnapshot,
  applyTicket,
  initialKds,
  orderedTickets,
  type KdsTicket,
  type OrderStatus,
} from '../src';

const ticket = (
  id: string,
  status: OrderStatus,
  createdAt = '2026-10-31T01:00:00.000Z',
): KdsTicket => ({
  id,
  orderNumber: id.toUpperCase(),
  status,
  channel: 'KIOSK',
  businessDay: '2026-10-31',
  customerName: null,
  subtotalMinor: 0,
  vatMinor: 0,
  totalMinor: 0,
  currency: 'THB',
  createdAt,
  expiresAt: null,
  items: [],
});

describe('applyTicket', () => {
  it('adds a PAID ticket and updates it in place', () => {
    let s = applyTicket(initialKds, ticket('a', 'PAID'));
    s = applyTicket(s, ticket('a', 'IN_PREPARATION'));
    expect(Object.keys(s.tickets)).toEqual(['a']);
    expect(s.tickets.a?.status).toBe('IN_PREPARATION');
  });

  it.each([
    'COMPLETED',
    'CANCELLED',
    'REFUNDED',
    'EXPIRED',
    'PENDING_PAYMENT',
  ] as const)('drops a ticket whose status is %s', (status) => {
    const s = applyTicket(
      applyTicket(initialKds, ticket('a', 'READY')),
      ticket('a', status),
    );
    expect(s.tickets.a).toBeUndefined();
  });

  it('ignores a late event that would move a ticket backwards', () => {
    let s = applyTicket(initialKds, ticket('a', 'READY'));
    s = applyTicket(s, ticket('a', 'IN_PREPARATION'));
    expect(s.tickets.a?.status).toBe('READY');
  });

  it('does not resurrect a ticket that already left the board', () => {
    let s = applyTicket(initialKds, ticket('a', 'READY'));
    s = applyTicket(s, ticket('a', 'COMPLETED'));
    s = applyTicket(s, ticket('a', 'READY'));
    expect(s.tickets.a).toBeUndefined();
  });

  it('does not mutate the previous state', () => {
    const before = applyTicket(initialKds, ticket('a', 'PAID'));
    const frozen = JSON.stringify(before);
    applyTicket(before, ticket('a', 'READY'));
    expect(JSON.stringify(before)).toBe(frozen);
  });
});

describe('applySnapshot', () => {
  it('replaces whatever was held, and forgets tombstones', () => {
    let s = applyTicket(initialKds, ticket('old', 'PAID'));
    s = applyTicket(s, ticket('x', 'COMPLETED'));
    s = applySnapshot(s, [ticket('x', 'READY'), ticket('new', 'PAID')]);
    expect(Object.keys(s.tickets).sort()).toEqual(['new', 'x']);
  });

  it('drops non-live tickets even when the snapshot contains them', () => {
    const s = applySnapshot(initialKds, [
      ticket('a', 'CANCELLED'),
      ticket('b', 'PAID'),
    ]);
    expect(Object.keys(s.tickets)).toEqual(['b']);
  });

  it('replays events that arrived during the fetch on top of the snapshot', () => {
    const s = applySnapshot(
      initialKds,
      [ticket('a', 'PAID')],
      [ticket('a', 'READY'), ticket('b', 'PAID')],
    );
    expect(s.tickets.a?.status).toBe('READY');
    expect(s.tickets.b).toBeDefined();
  });

  it('flags truncation exactly at the cap', () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ticket(`t${i}`, 'PAID'));
    expect(
      applySnapshot(initialKds, make(KDS_SNAPSHOT_LIMIT - 1)).truncated,
    ).toBe(false);
    expect(applySnapshot(initialKds, make(KDS_SNAPSHOT_LIMIT)).truncated).toBe(
      true,
    );
  });

  it('marks the state loaded even when the snapshot is empty', () => {
    expect(applySnapshot(initialKds, []).loaded).toBe(true);
    expect(initialKds.loaded).toBe(false);
  });
});

describe('orderedTickets', () => {
  it('sorts oldest first', () => {
    const s = applySnapshot(initialKds, [
      ticket('late', 'PAID', '2026-10-31T02:00:00.000Z'),
      ticket('early', 'PAID', '2026-10-31T01:00:00.000Z'),
    ]);
    expect(orderedTickets(s).map((t) => t.id)).toEqual(['early', 'late']);
  });
});
