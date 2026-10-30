import type { Database } from '../../database/database.module';
import { AfterCommit } from './after-commit.service';
import type { DomainEvent } from './domain-event';
import type { RealtimePublisher } from './realtime-publisher';

/** A database whose transaction commits or rolls back on command. */
const dbThat = (outcome: 'commits' | 'throws') => ({
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const result = await fn({});
    if (outcome === 'throws') throw new Error('rolled back');
    return result;
  },
});

const recorder = () => {
  const sent: DomainEvent[][] = [];
  const publisher: RealtimePublisher = {
    publish: (events) => {
      sent.push(events);
      return Promise.resolve();
    },
  };
  return { sent, publisher };
};

const anEvent: DomainEvent = {
  kind: 'order.paid',
  orderId: 'order-1',
  deviceId: null,
};

/**
 * The fake carries only the one method `AfterCommit` touches, so the assertion
 * goes through `unknown` rather than `any` — a stray `any` here would silently
 * stop type-checking every call in this file, which is the opposite of what a
 * spec is for.
 */
const build = (db: ReturnType<typeof dbThat>, publisher: RealtimePublisher) =>
  new AfterCommit(db as unknown as Database, publisher);

describe('AfterCommit', () => {
  it('publishes what the transaction emitted, once it has committed', async () => {
    const { sent, publisher } = recorder();

    const result = await build(dbThat('commits'), publisher).run(
      (_tx, emit) => {
        emit(anEvent);
        return Promise.resolve('done');
      },
    );

    expect(result).toBe('done');
    expect(sent).toEqual([[anEvent]]);
  });

  /**
   * The reason this class exists. A rolled-back transaction that had already
   * announced itself leaves the KDS holding a state the database never had,
   * and §5.5's recovery story cannot fix a lie it does not know it was told.
   */
  it('publishes nothing when the transaction rolls back', async () => {
    const { sent, publisher } = recorder();

    await expect(
      build(dbThat('throws'), publisher).run((_tx, emit) => {
        emit(anEvent);
        return Promise.resolve();
      }),
    ).rejects.toThrow('rolled back');

    expect(sent).toEqual([]);
  });

  it('does not publish an empty batch when nothing was emitted', async () => {
    const { sent, publisher } = recorder();

    await build(dbThat('commits'), publisher).run(() =>
      Promise.resolve(undefined),
    );

    expect(sent).toEqual([]);
  });

  /**
   * The money is committed by the time delivery is attempted. A dead Redis
   * must not turn a paid order into a 500 the cashier has to explain.
   */
  it('swallows a delivery failure rather than failing the committed work', async () => {
    const publisher: RealtimePublisher = {
      publish: () => Promise.reject(new Error('Connection is closed.')),
    };

    await expect(
      build(dbThat('commits'), publisher).run((_tx, emit) => {
        emit(anEvent);
        return Promise.resolve('committed');
      }),
    ).resolves.toBe('committed');
  });
});
