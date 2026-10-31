import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  NetworkError,
  createPaymentFlow,
  type ApiErrorCode,
  type PaymentFlowState,
  type PaymentGateway,
  type PaymentKeyStore,
} from '../src';
import { createFakeEvents } from './events';

const SECRET = 'pi_1_secret_abc';
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const problem = (
  status: number,
  code: ApiErrorCode,
  meta: Record<string, unknown> | null = null,
) =>
  new ApiError(
    status,
    {
      type: '',
      title: '',
      status,
      code,
      detail: '',
      requestId: '',
      errors: null,
      meta,
    },
    'x',
  );

const pending = (secret: string | null = SECRET, status = 'PENDING') => ({
  id: 'p1',
  status,
  method: null,
  amountMinor: 10900,
  currency: 'THB',
  provider: 'STRIPE',
  clientAction: secret
    ? { type: 'CONFIRM_WITH_CLIENT_SECRET', clientSecret: secret }
    : null,
});

const memoryKeys = () => {
  const map = new Map<string, string>();
  const keys: PaymentKeyStore = {
    get: (id) => map.get(id) ?? null,
    set: (id, key) => void map.set(id, key),
    clear: (id) => void map.delete(id),
  };
  return { keys, map };
};

const setup = (
  create: (...args: any[]) => Promise<unknown> = async () => pending(),
  gateway: Partial<PaymentGateway> = {},
  store = memoryKeys(),
  orderId = 'o1',
) => {
  const hub = createFakeEvents();
  const createPayment = vi.fn(create);
  const states: PaymentFlowState[] = [];
  const gw: PaymentGateway = {
    payByCard: vi.fn(async () => ({ ok: true as const })),
    startPromptPay: vi.fn(async () => ({
      ok: true as const,
      qrImageUrl: 'https://qr.example/1.svg',
    })),
    ...gateway,
  };
  const flow = createPaymentFlow({
    api: { orders: { createPayment } } as any,
    events: hub.events,
    gateway: gw,
    keys: store.keys,
    orderId,
    onChange: (s) => states.push(s),
  });
  return {
    flow,
    hub,
    createPayment,
    gw,
    store,
    states,
    last: () => states[states.length - 1]!,
    phases: () => states.map((s) => s.phase),
  };
};

const toQr = async (t: ReturnType<typeof setup>) => {
  await t.flow.start();
  await t.flow.payByPromptPay();
  expect(t.last().phase).toBe('qr');
};

describe('createPaymentFlow', () => {
  it('opens a payment and is ready to take a card or a QR once the client secret arrives', async () => {
    const t = setup();
    await t.flow.start();
    expect(t.phases()).toEqual(['opening', 'ready']);
    expect(t.createPayment).toHaveBeenCalledWith(
      'o1',
      { method: 'CARD' },
      expect.any(String),
    );
  });

  describe('the QR code', () => {
    it('comes down the moment payment.succeeded is pushed, with no request to the server', async () => {
      const t = setup();
      await toQr(t);
      t.hub.emit('payment.succeeded', { id: 'o1' });
      expect(t.last().phase).toBe('paid');
      expect(t.createPayment).toHaveBeenCalledTimes(1);
    });

    it('is not drawn for a push about someone else’s order', async () => {
      const t = setup();
      await toQr(t);
      t.hub.emit('payment.succeeded', { id: 'o2' });
      expect(t.last().phase).toBe('qr');
    });

    it('comes down when the order tracker finds the order paid, because a push can be lost', async () => {
      const t = setup();
      await toQr(t);
      t.flow.orderPhaseChanged('preparing');
      expect(t.last().phase).toBe('paid');
    });

    it('comes down when the order has expired', async () => {
      const t = setup();
      await toQr(t);
      t.flow.orderPhaseChanged('expired');
      expect(t.last().phase).toBe('expired');
    });

    it('comes down on a failure push, and the failed state is not undone by a late tracker poll', async () => {
      const t = setup();
      await toQr(t);
      t.hub.emit('payment.failed', { id: 'o1' });
      expect(t.last().phase).toBe('failed');
      t.flow.orderPhaseChanged('awaiting-payment');
      expect(t.last().phase).toBe('failed');
    });

    it('shows an error and stays on the choice when Stripe will not start it', async () => {
      const t = setup(undefined, {
        startPromptPay: async () => ({ ok: false, message: 'No QR' }),
      });
      await t.flow.start();
      await t.flow.payByPromptPay();
      expect(t.last()).toEqual({ phase: 'ready', message: 'No QR' });
    });
  });

  describe('the card', () => {
    it('is not a payment until the server says so', async () => {
      const t = setup();
      await t.flow.start();
      await t.flow.payByCard();
      expect(t.last().phase).toBe('card-processing');
      t.hub.emit('payment.succeeded', { id: 'o1' });
      expect(t.last().phase).toBe('paid');
    });

    it('keeps the same payment after a decline, so the customer can try another card', async () => {
      const payByCard = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, message: 'Declined' })
        .mockResolvedValueOnce({ ok: true });
      const t = setup(undefined, { payByCard });
      await t.flow.start();
      await t.flow.payByCard();
      expect(t.last()).toEqual({ phase: 'ready', message: 'Declined' });
      await t.flow.payByCard();
      expect(payByCard).toHaveBeenNthCalledWith(2, SECRET);
      expect(t.createPayment).toHaveBeenCalledTimes(1);
    });

    it('shows the card’s own decline reason once the server confirms the failure', async () => {
      const payByCard = vi.fn().mockResolvedValue({
        ok: false,
        message: 'Your card has been declined.',
        declined: true,
      });
      const t = setup(undefined, { payByCard });
      await t.flow.start();
      await t.flow.payByCard();
      expect(t.last().phase).toBe('ready');
      t.hub.emit('payment.failed', { id: 'o1' });
      expect(t.last()).toEqual({
        phase: 'failed',
        message: 'Your card has been declined.',
      });
    });

    it('does not blame the card for a failure it did not cause, nor carry a reason into the next attempt', async () => {
      const payByCard = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          message: 'Your card number is incomplete.',
        })
        .mockResolvedValueOnce({
          ok: false,
          message: 'Declined.',
          declined: true,
        });
      const t = setup(undefined, { payByCard });
      await t.flow.start();
      await t.flow.payByCard();
      t.hub.emit('payment.failed', { id: 'o1' });
      expect(t.last()).toEqual({ phase: 'failed', message: null });

      await t.flow.retry();
      await t.flow.payByCard();
      t.hub.emit('payment.failed', { id: 'o1' });
      expect(t.last()).toEqual({ phase: 'failed', message: 'Declined.' });
      await t.flow.retry();
      t.hub.emit('payment.failed', { id: 'o1' });
      expect(t.last()).toEqual({ phase: 'failed', message: null });
    });

    it('ignores a second tap while the first is still being processed', async () => {
      const payByCard = vi.fn(() => new Promise<never>(() => {}));
      const t = setup(undefined, { payByCard });
      await t.flow.start();
      void t.flow.payByCard();
      void t.flow.payByCard();
      await flush();
      expect(payByCard).toHaveBeenCalledTimes(1);
    });
  });

  describe('the idempotency key', () => {
    it('is the same after a reload, so the server replays the payment and hands back the secret again', async () => {
      const store = memoryKeys();
      const first = setup(undefined, {}, store);
      await first.flow.start();
      first.flow.stop();

      const second = setup(undefined, {}, store);
      await second.flow.start();

      const keyOf = (t: typeof first) => t.createPayment.mock.calls[0]![2];
      expect(keyOf(second)).toBe(keyOf(first));
      expect(second.last().phase).toBe('ready');
    });

    it('changes only after the payment failed, because the old key would replay the dead payment', async () => {
      const t = setup();
      await t.flow.start();
      t.hub.emit('payment.failed', { id: 'o1' });
      expect(t.store.map.has('o1')).toBe(false);
      await t.flow.retry();
      const [first, second] = t.createPayment.mock.calls.map((c) => c[2]);
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
      expect(t.last().phase).toBe('ready');
    });

    it('still settles when the money arrives after the failure, as when a second card is tried on the same intent', async () => {
      const t = setup();
      await t.flow.start();
      t.hub.emit('payment.failed', { id: 'o1' });
      expect(t.last().phase).toBe('failed');
      t.hub.emit('payment.succeeded', { id: 'o1' });
      expect(t.last().phase).toBe('paid');
    });

    it('does not open another payment on retry while one is live', async () => {
      const t = setup();
      await t.flow.start();
      await t.flow.retry();
      expect(t.createPayment).toHaveBeenCalledTimes(1);
    });

    it('is forgotten once the order is paid', async () => {
      const t = setup();
      await t.flow.start();
      expect(t.store.map.has('o1')).toBe(true);
      t.hub.emit('payment.succeeded', { id: 'o1' });
      expect(t.store.map.has('o1')).toBe(false);
    });

    it('is reused when a network failure is retried', async () => {
      let calls = 0;
      const t = setup(async () => {
        if (calls++ === 0) throw new NetworkError('x');
        return pending();
      });
      await t.flow.start();
      expect(t.last().phase).toBe('unavailable');
      await t.flow.retry();
      expect(t.phases()).toEqual([
        'opening',
        'unavailable',
        'opening',
        'ready',
      ]);
      expect(t.createPayment.mock.calls[1]![2]).toBe(
        t.createPayment.mock.calls[0]![2],
      );
    });
  });

  describe('endings the server can give', () => {
    it('treats 409 ORDER_EXPIRED as an ordinary ending and forgets the key', async () => {
      const t = setup(async () => {
        throw problem(409, 'ORDER_EXPIRED');
      });
      await t.flow.start();
      expect(t.last().phase).toBe('expired');
      expect(t.store.map.has('o1')).toBe(false);
    });

    it('cannot continue a payment it has no secret for', async () => {
      const t = setup(async () => {
        throw problem(409, 'PAYMENT_ALREADY_ACTIVE', {
          activePaymentId: 'p9',
        });
      });
      await t.flow.start();
      expect(t.last().phase).toBe('stuck');
      expect(t.store.map.has('o1')).toBe(true);
    });

    it('is paid when the replay shows a succeeded payment', async () => {
      const t = setup(async () => pending(null, 'SUCCEEDED'));
      await t.flow.start();
      expect(t.last().phase).toBe('paid');
    });

    it('opens a new payment when the replay shows a failed one', async () => {
      const t = setup(async () => pending(null, 'FAILED'));
      await t.flow.start();
      expect(t.last().phase).toBe('failed');
      expect(t.store.map.has('o1')).toBe(false);
    });

    it.each([
      ['PAID', 'paid'],
      ['READY', 'paid'],
      ['CANCELLED', 'closed'],
      ['EXPIRED', 'closed'],
    ])(
      'reads ORDER_NOT_PAYABLE for an order that is %s as %s',
      async (currentStatus, phase) => {
        const t = setup(async () => {
          throw problem(409, 'ORDER_NOT_PAYABLE', { currentStatus });
        });
        await t.flow.start();
        expect(t.last().phase).toBe(phase);
      },
    );

    it('does not mistake a failure push for the old payment while a new one is opening', async () => {
      let release: (v: unknown) => void = () => {};
      const t = setup(() => new Promise((resolve) => (release = resolve)));
      const started = t.flow.start();
      t.hub.emit('payment.failed', { id: 'o1' });
      expect(t.last().phase).toBe('opening');
      release(pending());
      await started;
      expect(t.last().phase).toBe('ready');
    });
  });

  it('stops listening, and says nothing more, once stopped', async () => {
    const t = setup();
    await t.flow.start();
    t.flow.stop();
    expect(t.hub.listeners()).toBe(0);
    const count = t.states.length;
    t.hub.emit('payment.succeeded', { id: 'o1' });
    expect(t.states.length).toBe(count);
  });
});
