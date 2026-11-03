import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  NetworkError,
  createKioskFeed,
  createOrderTracker,
  phaseOf,
  type ApiErrorCode,
  type KioskFeedState,
  type Menu,
  type OrderPhase,
} from '../src';
import { createFakeEvents } from './events';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const menuV = (name: string): Menu => ({
  categories: [{ id: name, name, sortOrder: 0, items: [] }],
});
const unauthorized = (code: ApiErrorCode = 'DEVICE_REVOKED') =>
  new ApiError(
    401,
    {
      type: '',
      title: '',
      status: 401,
      code,
      detail: '',
      requestId: '',
      errors: null,
      meta: null,
    },
    'x',
  );
const revoked = () => unauthorized();

describe('createKioskFeed', () => {
  const setup = (
    menuGet: (etag?: string | null) => Promise<any>,
    me: () => Promise<any> = async () => ({ type: 'device', status: 'ACTIVE' }),
  ) => {
    const states: KioskFeedState[] = [];
    const api = {
      menu: { get: vi.fn(menuGet) },
      auth: { me: vi.fn(me) },
    } as any;
    const feed = createKioskFeed({ api, onChange: (s) => states.push(s) });
    return { api, feed, last: () => states[states.length - 1]! };
  };

  it('sends the previous ETag and keeps the menu on a 304', async () => {
    const { api, feed, last } = setup(async (etag) =>
      etag
        ? { modified: false }
        : { modified: true, menu: menuV('A'), etag: '"1"' },
    );
    feed.start();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.menu.get).toHaveBeenLastCalledWith('"1"');
    expect(last().menu?.categories[0]?.name).toBe('A');
    feed.stop();
  });

  it('marks offline on a network failure but keeps the menu, then recovers', async () => {
    let fail = false;
    const { feed, last } = setup(async () => {
      if (fail) throw new NetworkError('x');
      return { modified: true, menu: menuV('A'), etag: '"1"' };
    });
    feed.start();
    await flush();
    fail = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(last().online).toBe(false);
    expect(last().menu).not.toBeNull();
    fail = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(last().online).toBe(true);
    feed.stop();
  });

  it('reports a device that was paused or revoked', async () => {
    let status = 'ACTIVE';
    const { feed, last } = setup(
      async () => ({ modified: false }),
      async () => ({ type: 'device', status }),
    );
    feed.start();
    await flush();
    status = 'PAUSED';
    await vi.advanceTimersByTimeAsync(15_000);
    expect(last().status).toBe('PAUSED');
    feed.stop();
  });

  it('treats a 401 DEVICE_REVOKED as revoked', async () => {
    const { feed, last } = setup(
      async () => ({ modified: false }),
      async () => Promise.reject(revoked()),
    );
    feed.start();
    await flush();
    expect(last().status).toBe('REVOKED');
    feed.stop();
  });

  it('treats a 401 for a token the server does not know as unpaired', async () => {
    const { feed, last } = setup(
      async () => ({ modified: false }),
      async () => Promise.reject(unauthorized('AUTH_TOKEN_INVALID')),
    );
    feed.start();
    await flush();
    expect(last().status).toBe('REVOKED');
    feed.stop();
  });

  it('catches the unknown token on the menu poll too', async () => {
    const { feed, last } = setup(async () =>
      Promise.reject(unauthorized('AUTH_TOKEN_INVALID')),
    );
    feed.start();
    await flush();
    expect(last().status).toBe('REVOKED');
    feed.stop();
  });

  it('keeps polling through a server error instead of reporting unpaired', async () => {
    const serverError = new ApiError(503, null, 'unavailable');
    const { feed, last } = setup(
      async () => ({ modified: false }),
      async () => Promise.reject(serverError),
    );
    feed.start();
    await flush();
    expect(last().status).toBeNull();
    feed.stop();
  });

  it('does not stack a new poll on top of one still in flight', async () => {
    const { api, feed } = setup(() => new Promise(() => {}));
    feed.start();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(api.menu.get).toHaveBeenCalledTimes(1);
    feed.stop();
  });
});

describe('phaseOf', () => {
  it.each([
    ['PENDING_PAYMENT', false, 'awaiting-payment'],
    ['PENDING_PAYMENT', true, 'payment-failed'],
    ['PAID', true, 'paid'],
    ['IN_PREPARATION', false, 'preparing'],
    ['READY', false, 'ready'],
    ['COMPLETED', false, 'collected'],
    ['EXPIRED', false, 'expired'],
    ['CANCELLED', false, 'cancelled'],
    ['REFUNDED', false, 'refunded'],
  ] as const)('%s (failed=%s) → %s', (status, failed, phase) => {
    expect(phaseOf(status, failed)).toBe(phase);
  });
});

describe('createOrderTracker', () => {
  const setup = (statuses: string[]) => {
    const hub = createFakeEvents();
    let i = 0;
    const api = {
      orders: {
        get: vi.fn(async () => ({
          status: statuses[Math.min(i++, statuses.length - 1)],
        })),
      },
    } as any;
    const seen: [OrderPhase, boolean][] = [];
    const t = createOrderTracker({
      api,
      events: hub.events,
      orderId: 'o1',
      onChange: (p, o) => seen.push([p, o]),
    });
    return { api, hub, t, last: () => seen[seen.length - 1]! };
  };

  it('picks up PAID from the first look', async () => {
    const { t, last } = setup(['PAID']);
    t.start();
    await flush();
    expect(last()[0]).toBe('paid');
    t.stop();
  });

  it('polls to learn of COMPLETED, which is never pushed, then stops polling', async () => {
    const { t, api, last } = setup(['READY', 'READY', 'COMPLETED']);
    t.start();
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(last()[0]).toBe('collected');
    const calls = api.orders.get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.orders.get.mock.calls.length).toBe(calls);
  });

  it('looks again straight away when a push for this order arrives, and ignores others', async () => {
    const { t, hub, api } = setup(['PENDING_PAYMENT', 'PAID']);
    t.start();
    await flush();
    hub.emit('payment.succeeded', { id: 'other' });
    await flush();
    expect(api.orders.get).toHaveBeenCalledTimes(1);
    hub.emit('payment.succeeded', { id: 'o1' });
    await flush();
    expect(api.orders.get).toHaveBeenCalledTimes(2);
    t.stop();
  });

  it('shows payment-failed until a new attempt clears it', async () => {
    const { t, hub, last } = setup(['PENDING_PAYMENT']);
    t.start();
    await flush();
    hub.emit('payment.failed', { id: 'o1' });
    await flush();
    expect(last()[0]).toBe('payment-failed');
    t.clearPaymentFailure();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(last()[0]).toBe('awaiting-payment');
    t.stop();
  });

  it('stops listening to the socket when it stops, so a long-lived socket does not collect handlers', async () => {
    const { t, hub } = setup(['PENDING_PAYMENT', 'COMPLETED']);
    expect(hub.listeners()).toBe(4);
    t.start();
    await flush();
    t.stop();
    expect(hub.listeners()).toBe(0);
  });

  it('stops listening on its own once the order is final', async () => {
    const { t, hub } = setup(['COMPLETED']);
    t.start();
    await flush();
    expect(hub.listeners()).toBe(0);
    t.stop();
  });

  it('reports offline without losing the phase', async () => {
    let fail = false;
    const hub = createFakeEvents();
    const api = {
      orders: {
        get: async () => {
          if (fail) throw new NetworkError('x');
          return { status: 'IN_PREPARATION' };
        },
      },
    } as any;
    const seen: [OrderPhase, boolean][] = [];
    const t = createOrderTracker({
      api,
      events: hub.events,
      orderId: 'o1',
      onChange: (p, o) => seen.push([p, o]),
    });
    t.start();
    await flush();
    fail = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen[seen.length - 1]).toEqual(['preparing', false]);
    t.stop();
  });
});
