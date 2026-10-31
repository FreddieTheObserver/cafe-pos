import { ApiError, NetworkError } from '../errors';
import type { ApiClient } from '../client';
import type { OrderStatus } from '../types';

export type OrderPhase =
  | 'awaiting-payment'
  | 'payment-failed'
  | 'paid'
  | 'preparing'
  | 'ready'
  | 'collected'
  | 'expired'
  | 'cancelled'
  | 'refunded';

export const phaseOf = (
  status: OrderStatus,
  paymentFailed: boolean,
): OrderPhase => {
  switch (status) {
    case 'PAID':
      return 'paid';
    case 'IN_PREPARATION':
      return 'preparing';
    case 'READY':
      return 'ready';
    case 'COMPLETED':
      return 'collected';
    case 'EXPIRED':
      return 'expired';
    case 'CANCELLED':
      return 'cancelled';
    case 'REFUNDED':
      return 'refunded';
    default:
      return paymentFailed ? 'payment-failed' : 'awaiting-payment';
  }
};

/** A phase nothing will move out of; the tracker stops polling. */
export const isFinal = (p: OrderPhase) =>
  ['collected', 'expired', 'cancelled', 'refunded'].includes(p);

export interface TrackerSocket {
  on(
    event: 'payment.succeeded' | 'payment.failed' | 'order.ready',
    cb: (t: { id: string }) => void,
  ): unknown;
  on(event: 'connect', cb: () => void): unknown;
}

export interface OrderTrackerOptions {
  api: Pick<ApiClient, 'orders'>;
  socket: TrackerSocket;
  orderId: string;
  onChange: (phase: OrderPhase, online: boolean) => void;
  pollMs?: number;
}

/**
 * Follows one order. Pushes are only a nudge to look again: the kiosk is never told about
 * COMPLETED, REFUNDED or a staff cancellation (docs/api.md §7.4), so polling the order
 * is the source of truth and the socket just makes the common case instant.
 */
export const createOrderTracker = (opts: OrderTrackerOptions) => {
  let paymentFailed = false;
  let phase: OrderPhase = 'awaiting-payment';
  let online = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  const emit = () => opts.onChange(phase, online);

  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const order = await opts.api.orders.get(opts.orderId);
      phase = phaseOf(order.status, paymentFailed);
      online = true;
      if (isFinal(phase)) stop();
    } catch (err) {
      if (err instanceof NetworkError) online = false;
      else if (err instanceof ApiError && err.status >= 500) online = false;
    } finally {
      busy = false;
      emit();
    }
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  const mine = (t: { id: string }) => t.id === opts.orderId;
  opts.socket.on('payment.succeeded', (t) => mine(t) && void check());
  opts.socket.on('order.ready', (t) => mine(t) && void check());
  opts.socket.on('payment.failed', (t) => {
    if (!mine(t)) return;
    paymentFailed = true;
    void check();
  });
  opts.socket.on('connect', () => void check());

  return {
    start() {
      void check();
      timer = setInterval(() => void check(), opts.pollMs ?? 3_000);
    },
    stop,
    /** Call when the customer starts another payment attempt. */
    clearPaymentFailure() {
      paymentFailed = false;
    },
  };
};
