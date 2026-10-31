import { ApiError } from '../errors';
import { newIdempotencyKey, type ApiClient } from '../client';
import type { KioskEvents } from '../realtime';
import type { OrderPhase } from './order-tracker';

export type PaymentFlowState =
  | { phase: 'opening' }
  | { phase: 'ready'; message: string | null }
  | { phase: 'card-processing' }
  | { phase: 'starting-qr' }
  | { phase: 'qr'; qrImageUrl: string }
  | { phase: 'paid' }
  | { phase: 'failed'; message: string | null }
  | { phase: 'expired' }
  | { phase: 'closed' }
  | { phase: 'stuck' }
  | { phase: 'unavailable' };

export type CardResult =
  { ok: true } | { ok: false; message: string; declined?: boolean };
export type QrResult =
  { ok: true; qrImageUrl: string } | { ok: false; message: string };

export interface PaymentGateway {
  payByCard(clientSecret: string): Promise<CardResult>;
  startPromptPay(clientSecret: string): Promise<QrResult>;
}

export interface PaymentKeyStore {
  get(orderId: string): string | null;
  set(orderId: string, key: string): void;
  clear(orderId: string): void;
}

export interface PaymentFlowOptions {
  api: Pick<ApiClient, 'orders'>;
  events: KioskEvents;
  gateway: PaymentGateway;
  keys: PaymentKeyStore;
  orderId: string;
  onChange: (state: PaymentFlowState) => void;
}

const SETTLED = new Set<PaymentFlowState['phase']>([
  'paid',
  'expired',
  'closed',
]);
const PAID_STATUSES = ['PAID', 'IN_PREPARATION', 'READY', 'COMPLETED'];

export const createPaymentFlow = (opts: PaymentFlowOptions) => {
  let state: PaymentFlowState = { phase: 'opening' };
  let clientSecret: string | null = null;
  let stopped = false;
  let declined: string | null = null;
  const phase = () => state.phase;

  const set = (next: PaymentFlowState) => {
    if (stopped || SETTLED.has(state.phase)) return;
    state = next;
    if (SETTLED.has(next.phase) || next.phase === 'failed')
      opts.keys.clear(opts.orderId);
    opts.onChange(state);
  };

  const open = async () => {
    set({ phase: 'opening' });
    let key = opts.keys.get(opts.orderId);
    if (!key) {
      key = newIdempotencyKey();
      opts.keys.set(opts.orderId, key);
    }
    try {
      const payment = await opts.api.orders.createPayment(
        opts.orderId,
        { method: 'CARD' },
        key,
      );
      if (payment.status === 'SUCCEEDED') return set({ phase: 'paid' });
      const secret = payment.clientAction?.clientSecret;
      if (!secret) {
        const dead = ['FAILED', 'CANCELLED', 'EXPIRED'].includes(
          payment.status,
        );
        return set(
          dead ? { phase: 'failed', message: null } : { phase: 'stuck' },
        );
      }
      clientSecret = secret;
      set({ phase: 'ready', message: null });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'ORDER_EXPIRED') return set({ phase: 'expired' });
        if (err.code === 'RESOURCE_NOT_FOUND') return set({ phase: 'closed' });
        if (err.code === 'PAYMENT_ALREADY_ACTIVE')
          return set({ phase: 'stuck' });
        if (err.code === 'ORDER_NOT_PAYABLE') {
          const current = String(err.problem?.meta?.currentStatus ?? '');
          return set({
            phase: PAID_STATUSES.includes(current) ? 'paid' : 'closed',
          });
        }
      }
      set({ phase: 'unavailable' });
    }
  };

  const unsubscribe = [
    opts.events.on('payment.succeeded', (t) => {
      if (t.id === opts.orderId) set({ phase: 'paid' });
    }),
    opts.events.on('payment.failed', (t) => {
      if (t.id !== opts.orderId) return;
      // Before a payment exists, a failure can only belong to the previous attempt.
      if (phase() === 'opening' || phase() === 'failed') return;
      set({ phase: 'failed', message: declined });
      declined = null;
    }),
  ];

  return {
    start: open,
    state: () => state,
    /** After `failed` this opens a new payment under a new key; after `unavailable` it repeats the same request. */
    retry() {
      if (phase() === 'failed' || phase() === 'unavailable') return open();
    },
    async payByCard() {
      if (phase() !== 'ready' || !clientSecret) return;
      declined = null;
      set({ phase: 'card-processing' });
      const result = await opts.gateway.payByCard(clientSecret);
      // A card that went through is not a payment: only the server says so.
      if (result.ok || phase() !== 'card-processing') return;
      // A decline is followed by the server's own failure, so keep the reason for that screen.
      if (result.declined) declined = result.message;
      set({ phase: 'ready', message: result.message });
    },
    async payByPromptPay() {
      if (phase() !== 'ready' || !clientSecret) return;
      set({ phase: 'starting-qr' });
      const result = await opts.gateway.startPromptPay(clientSecret);
      if (phase() !== 'starting-qr') return;
      set(
        result.ok
          ? { phase: 'qr', qrImageUrl: result.qrImageUrl }
          : { phase: 'ready', message: result.message },
      );
    },
    /** The order tracker's view: a poll that finds the order paid, expired or gone settles the flow without a push. */
    orderPhaseChanged(order: OrderPhase) {
      if (['paid', 'preparing', 'ready', 'collected'].includes(order))
        set({ phase: 'paid' });
      else if (order === 'expired') set({ phase: 'expired' });
      else if (order === 'cancelled' || order === 'refunded')
        set({ phase: 'closed' });
    },
    stop() {
      stopped = true;
      for (const off of unsubscribe.splice(0)) off();
    },
  };
};
