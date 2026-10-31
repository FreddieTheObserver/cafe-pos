import { describe, expect, it } from 'vitest';
import {
  createBoardController,
  type BoardEntry,
  type BoardState,
  type BoardTransport,
} from '../src';

const e = (n: number, status: BoardEntry['status'] = 'READY'): BoardEntry => ({
  orderNumber: `A${n}`,
  status,
});

const fakeSocket = () => {
  const h: Record<string, (arg?: never) => void> = {};
  const socket = {
    on: (ev: string, cb: (arg?: never) => void) => void (h[ev] = cb),
    connect: () => {},
    disconnect: () => {},
  } as unknown as BoardTransport;
  return { socket, fire: (ev: string, arg?: unknown) => h[ev]?.(arg as never) };
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const setup = (fetchSnapshot: () => Promise<BoardEntry[]>) => {
  const { socket, fire } = fakeSocket();
  const seen: { state: BoardState; connected: boolean }[] = [];
  const c = createBoardController({
    socket,
    fetchSnapshot,
    onChange: (state, connected) => seen.push({ state, connected }),
  });
  c.start();
  return { fire, seen, last: () => seen[seen.length - 1]! };
};

describe('createBoardController', () => {
  it('shows the snapshot loaded at start', async () => {
    const t = setup(() => Promise.resolve([e(1)]));
    await Promise.resolve();
    await Promise.resolve();
    expect(t.last().state.entries).toEqual([e(1)]);
  });

  it('discards a snapshot that was requested before a newer push arrived', async () => {
    const d = deferred<BoardEntry[]>();
    const t = setup(() => d.promise);
    t.fire('board.updated', [e(2)]);
    d.resolve([e(1)]);
    await d.promise;
    await Promise.resolve();
    expect(t.last().state.entries).toEqual([e(2)]);
  });

  it('re-fetches on reconnect and reports connection state', async () => {
    let n = 0;
    const t = setup(() => Promise.resolve([e(++n)]));
    t.fire('connect');
    expect(t.last().connected).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.last().state.entries).toEqual([e(2)]);
    t.fire('disconnect');
    expect(t.last().connected).toBe(false);
  });

  it('keeps the last board when a snapshot fails', async () => {
    let fail = false;
    const t = setup(() =>
      fail ? Promise.reject(new Error('x')) : Promise.resolve([e(1)]),
    );
    await new Promise((r) => setTimeout(r, 0));
    fail = true;
    t.fire('connect');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.last().state.entries).toEqual([e(1)]);
  });
});
