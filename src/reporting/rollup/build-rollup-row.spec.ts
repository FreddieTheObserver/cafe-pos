import {
  buildRollupRow,
  UNKNOWN_METHOD,
  type RollupParts,
} from './build-rollup-row';

const EMPTY: RollupParts = {
  statusCounts: [],
  revenueByMethod: [],
  refundsMinor: 0,
  vatMinor: 0,
  ordersSettled: 0,
  items: [],
};

const parts = (over: Partial<RollupParts> = {}): RollupParts => ({
  ...EMPTY,
  ...over,
});

describe('buildRollupRow', () => {
  it('counts each terminal status into its own column', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        statusCounts: [
          { status: 'COMPLETED', count: 412 },
          { status: 'REFUNDED', count: 3 },
          { status: 'CANCELLED', count: 9 },
          { status: 'EXPIRED', count: 17 },
        ],
      }),
    );

    expect(row.ordersCompleted).toBe(412);
    expect(row.ordersRefunded).toBe(3);
    expect(row.ordersCancelled).toBe(9);
    expect(row.ordersExpired).toBe(17);
  });

  it('defaults a status that saw no orders to zero, not undefined', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({ statusCounts: [{ status: 'COMPLETED', count: 5 }] }),
    );

    expect(row.ordersCancelled).toBe(0);
    expect(row.ordersExpired).toBe(0);
    expect(row.ordersRefunded).toBe(0);
  });

  it('reproduces §5.3 worked example: cash is in the total', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        revenueByMethod: [
          { method: 'CARD', totalMinor: 2_100_000 },
          { method: 'PROMPTPAY', totalMinor: 2_300_000 },
          { method: 'CASH', totalMinor: 412_000 },
        ],
      }),
    );

    expect(row.revenueMinor).toBe(4_812_000);
    expect(row.revenueByMethod).toEqual({
      CARD: 2_100_000,
      PROMPTPAY: 2_300_000,
      CASH: 412_000,
    });
  });

  it('buckets an unresolved method under UNKNOWN rather than dropping it', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        revenueByMethod: [
          { method: 'CARD', totalMinor: 10_000 },
          { method: null, totalMinor: 1_500 },
        ],
      }),
    );

    expect(row.revenueByMethod[UNKNOWN_METHOD]).toBe(1_500);
    // The invariant the Z-report exists to guarantee.
    expect(row.revenueMinor).toBe(11_500);
  });

  it('keeps Σ by_method equal to revenue_minor for any input', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        revenueByMethod: [
          { method: 'CARD', totalMinor: 7 },
          { method: 'CASH', totalMinor: 11 },
          { method: null, totalMinor: 13 },
        ],
      }),
    );

    const summed = Object.values(row.revenueByMethod).reduce(
      (a, b) => a + b,
      0,
    );
    expect(summed).toBe(row.revenueMinor);
  });

  it('orders items by quantity descending, then by name', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        items: [
          { menuItemId: 'c', name: 'Croissant', quantity: 12, revenueMinor: 1 },
          { menuItemId: 'a', name: 'Americano', quantity: 84, revenueMinor: 2 },
          { menuItemId: 'l', name: 'Latte', quantity: 84, revenueMinor: 3 },
        ],
      }),
    );

    expect(row.topItems.map((i) => i.name)).toEqual([
      'Americano',
      'Latte',
      'Croissant',
    ]);
  });

  it('produces a zero row for a day the cafe never opened', () => {
    const row = buildRollupRow('2026-06-11', parts());

    expect(row).toEqual({
      businessDay: '2026-06-11',
      ordersCompleted: 0,
      ordersRefunded: 0,
      ordersCancelled: 0,
      ordersExpired: 0,
      ordersSettled: 0,
      revenueMinor: 0,
      revenueByMethod: {},
      refundsMinor: 0,
      vatMinor: 0,
      topItems: [],
    });
  });

  it('carries the settled-order count through', () => {
    const row = buildRollupRow('2026-06-11', parts({ ordersSettled: 84 }));

    expect(row.ordersSettled).toBe(84);
  });

  it('reports zero settled orders for a day that took no money', () => {
    const row = buildRollupRow('2026-06-11', parts());

    expect(row.ordersSettled).toBe(0);
  });

  it('carries an aggregate past int32, which is why the columns are bigint', () => {
    const row = buildRollupRow(
      '2026-06-11',
      parts({
        revenueByMethod: [
          { method: 'CARD', totalMinor: 2_000_000_000 },
          { method: 'PROMPTPAY', totalMinor: 2_000_000_000 },
        ],
      }),
    );

    // 4e9 > 2_147_483_647. An int32 column would have thrown before here.
    expect(row.revenueMinor).toBe(4_000_000_000);
    expect(Number.isSafeInteger(row.revenueMinor)).toBe(true);
  });
});
