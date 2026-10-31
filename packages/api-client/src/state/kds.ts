import type { KdsTicket, OrderStatus } from '../types';

/** The snapshot endpoint's cap. Reaching it means older tickets may be missing. */
export const KDS_SNAPSHOT_LIMIT = 200;

const RANK = { PAID: 0, IN_PREPARATION: 1, READY: 2 } as const;
type LiveStatus = keyof typeof RANK;

const isLive = (status: OrderStatus): status is LiveStatus => status in RANK;

export interface KdsState {
  tickets: Record<string, KdsTicket>;
  /**
   * Ids that left the board (completed, cancelled, refunded). Without this a late
   * `order.ready` that arrives after `COMPLETED` would put the ticket back.
   */
  gone: Record<string, true>;
  truncated: boolean;
  loaded: boolean;
}

export const initialKds: KdsState = {
  tickets: {},
  gone: {},
  truncated: false,
  loaded: false,
};

/**
 * Applies one pushed ticket. Events are full snapshots, but they can still arrive
 * out of order, so a ticket never moves backwards (READY → IN_PREPARATION) and a
 * ticket that has left stays gone until the next snapshot.
 */
export const applyTicket = (state: KdsState, ticket: KdsTicket): KdsState => {
  if (state.gone[ticket.id]) return state;

  if (!isLive(ticket.status)) {
    const { [ticket.id]: _dropped, ...rest } = state.tickets;
    return {
      ...state,
      tickets: rest,
      gone: { ...state.gone, [ticket.id]: true },
    };
  }

  const held = state.tickets[ticket.id];
  if (held && isLive(held.status) && RANK[ticket.status] < RANK[held.status])
    return state;

  return { ...state, tickets: { ...state.tickets, [ticket.id]: ticket } };
};

/**
 * Replaces everything from `GET /kds/orders`, then replays events that arrived
 * while the request was in flight. Call this on start and on every reconnect.
 */
export const applySnapshot = (
  _state: KdsState,
  snapshot: readonly KdsTicket[],
  replay: readonly KdsTicket[] = [],
): KdsState => {
  let next: KdsState = {
    tickets: {},
    gone: {},
    truncated: snapshot.length >= KDS_SNAPSHOT_LIMIT,
    loaded: true,
  };
  for (const ticket of snapshot) next = applyTicket(next, ticket);
  for (const ticket of replay) next = applyTicket(next, ticket);
  return next;
};

/** Oldest first: the order the kitchen should work them in. */
export const orderedTickets = (state: KdsState): KdsTicket[] =>
  Object.values(state.tickets).sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
