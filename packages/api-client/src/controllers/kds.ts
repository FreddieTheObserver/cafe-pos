import {
  applySnapshot,
  applyTicket,
  initialKds,
  type KdsState,
} from '../state/kds';
import type { KdsTicket } from '../types';

type TicketEvent = 'order.paid' | 'order.updated' | 'order.ready';

export interface KdsTransport {
  on(event: TicketEvent, cb: (ticket: KdsTicket) => void): unknown;
  on(event: 'connect' | 'disconnect', cb: () => void): unknown;
  on(event: 'connect_error', cb: (err: Error) => void): unknown;
  connect(): unknown;
  disconnect(): unknown;
}

export interface KdsControllerOptions {
  socket: KdsTransport;
  fetchSnapshot: () => Promise<KdsTicket[]>;
  onChange: (state: KdsState, connected: boolean) => void;
  /** A ticket just became PAID that this screen had not seen — the moment to chime. */
  onNewOrder?: (ticket: KdsTicket) => void;
  /** The handshake was refused; refresh the token or sign in again. */
  onUnauthorized?: () => void;
}

const EVENTS: TicketEvent[] = ['order.paid', 'order.updated', 'order.ready'];

export const createKdsController = (opts: KdsControllerOptions) => {
  let state = initialKds;
  let connected = false;
  let loading = false;
  let buffered: KdsTicket[] = [];

  const emit = () => opts.onChange(state, connected);

  const push = (ticket: KdsTicket) => {
    if (loading) buffered.push(ticket);
    const before = state.tickets[ticket.id];
    state = applyTicket(state, ticket);
    if (!before && ticket.status === 'PAID' && state.tickets[ticket.id])
      opts.onNewOrder?.(ticket);
    emit();
  };

  const refresh = async () => {
    if (loading) return;
    loading = true;
    buffered = [];
    try {
      const snapshot = await opts.fetchSnapshot();
      state = applySnapshot(state, snapshot, buffered);
      emit();
    } catch {
      // Keep what is on screen; the next reconnect retries.
    } finally {
      loading = false;
      buffered = [];
    }
  };

  for (const ev of EVENTS) opts.socket.on(ev, push);
  opts.socket.on('connect', () => {
    connected = true;
    emit();
    void refresh();
  });
  opts.socket.on('disconnect', () => {
    connected = false;
    emit();
  });
  opts.socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') opts.onUnauthorized?.();
  });

  return {
    start() {
      opts.socket.connect();
      void refresh();
    },
    stop() {
      opts.socket.disconnect();
    },
    refresh,
  };
};
