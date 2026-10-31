import { describe, expect, it } from 'vitest';
import {
  createKdsController,
  type KdsState,
  type KdsTicket,
  type KdsTransport,
} from '../src';

const t = (id: string, status: KdsTicket['status']): KdsTicket => ({
  id,
  orderNumber: id,
  status,
  channel: 'KIOSK',
  businessDay: 'd',
  customerName: null,
  subtotalMinor: 0,
  vatMinor: 0,
  totalMinor: 0,
  currency: 'THB',
  createdAt: id,
  expiresAt: null,
  items: [],
});

const fake = () => {
  const h: Record<string, (a?: never) => void> = {};
  const socket = {
    on: (e: string, cb: (a?: never) => void) => void (h[e] = cb),
    connect() {},
    disconnect() {},
  } as unknown as KdsTransport;
  return { socket, fire: (e: string, a?: unknown) => h[e]?.(a as never) };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const setup = (fetchSnapshot: () => Promise<KdsTicket[]>) => {
  const { socket, fire } = fake();
  let state!: KdsState;
  const chimes: string[] = [];
  let unauthorized = 0;
  createKdsController({
    socket,
    fetchSnapshot,
    onChange: (s) => (state = s),
    onNewOrder: (x) => chimes.push(x.id),
    onUnauthorized: () => unauthorized++,
  }).start();
  return { fire, state: () => state, chimes, unauthorized: () => unauthorized };
};

describe('createKdsController', () => {
  it('loads the snapshot on start without chiming for it', async () => {
    const x = setup(() => Promise.resolve([t('a', 'PAID')]));
    await tick();
    expect(Object.keys(x.state().tickets)).toEqual(['a']);
    expect(x.chimes).toEqual([]);
  });

  it('chimes once for a new paid order, not for later updates to it', async () => {
    const x = setup(() => Promise.resolve([]));
    await tick();
    x.fire('order.paid', t('a', 'PAID'));
    x.fire('order.paid', t('a', 'PAID'));
    x.fire('order.updated', t('a', 'IN_PREPARATION'));
    expect(x.chimes).toEqual(['a']);
  });

  it('does not chime for a ticket first seen after it was already in preparation', async () => {
    const x = setup(() => Promise.resolve([]));
    await tick();
    x.fire('order.updated', t('a', 'IN_PREPARATION'));
    expect(x.chimes).toEqual([]);
  });

  it('replays events that arrive while the snapshot is loading', async () => {
    let release!: (v: KdsTicket[]) => void;
    const x = setup(() => new Promise((r) => (release = r)));
    x.fire('order.ready', t('a', 'READY'));
    release([t('a', 'PAID')]);
    await tick();
    expect(x.state().tickets.a?.status).toBe('READY');
  });

  it('reloads the snapshot on reconnect', async () => {
    let n = 0;
    const x = setup(() => Promise.resolve([t(`s${++n}`, 'PAID')]));
    await tick();
    x.fire('connect');
    await tick();
    expect(Object.keys(x.state().tickets)).toEqual(['s2']);
  });

  it('reports a refused handshake only for unauthorized', async () => {
    const x = setup(() => Promise.resolve([]));
    x.fire('connect_error', new Error('xhr poll error'));
    expect(x.unauthorized()).toBe(0);
    x.fire('connect_error', new Error('unauthorized'));
    expect(x.unauthorized()).toBe(1);
  });
});
