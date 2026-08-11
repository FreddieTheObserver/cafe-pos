import type { RollupRow } from '../rollup/build-rollup-row';
import {
  avgTicketMinor,
  mergeTopItems,
  salesBucket,
  type DayItems,
} from './shape-reports';

const row = (over: Partial<RollupRow> = {}): RollupRow => ({
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
  ...over,
});

describe('avgTicketMinor', () => {
  it('rounds to the nearest satang', () => {
    // 412000 / 84 = 4904.76…
    expect(avgTicketMinor(412_000, 84)).toBe(4905);
  });

  it('rounds half away from zero, matching Math.round', () => {
    expect(avgTicketMinor(5, 2)).toBe(3);
  });

  it('is null when no order took money, rather than dividing by zero', () => {
    expect(avgTicketMinor(0, 0)).toBeNull();
  });

  it('is null even when revenue is somehow non-zero with no settled orders', () => {
    // Not reachable through the aggregates, but Infinity must never be a
    // money field on the wire.
    expect(avgTicketMinor(1_000, 0)).toBeNull();
  });
});

describe('salesBucket', () => {
  it('carries revenue and the settled count, with the average derived', () => {
    const bucket = salesBucket(
      '2026-06-11',
      row({ revenueMinor: 412_000, ordersSettled: 84 }),
    );

    expect(bucket).toEqual({
      bucket: '2026-06-11',
      revenueMinor: 412_000,
      ordersSettled: 84,
      avgTicketMinor: 4905,
    });
  });

  it('reports a day with no trade as zeros and a null average', () => {
    expect(salesBucket('2026-06-11', row())).toEqual({
      bucket: '2026-06-11',
      revenueMinor: 0,
      ordersSettled: 0,
      avgTicketMinor: null,
    });
  });
});

describe('mergeTopItems', () => {
  const days: DayItems[] = [
    {
      businessDay: '2026-06-01',
      topItems: [
        { menuItemId: 'latte', name: 'Latte', quantity: 10, revenueMinor: 100 },
        { menuItemId: 'bun', name: 'Bun', quantity: 4, revenueMinor: 40 },
      ],
    },
    {
      businessDay: '2026-06-02',
      topItems: [
        { menuItemId: 'latte', name: 'Latte', quantity: 5, revenueMinor: 50 },
      ],
    },
  ];

  it('sums quantity and revenue per item across days', () => {
    expect(mergeTopItems(days, 10)).toEqual([
      { menuItemId: 'latte', name: 'Latte', quantity: 15, revenueMinor: 150 },
      { menuItemId: 'bun', name: 'Bun', quantity: 4, revenueMinor: 40 },
    ]);
  });

  /**
   * The producer groups by (menu_item_id, name_snapshot), so renaming an item
   * mid-service splits it into two stored entries for that day. Rejoining on id
   * is what makes the split invisible to a caller.
   */
  it('rejoins an item that was renamed mid-service', () => {
    const renamed: DayItems[] = [
      {
        businessDay: '2026-06-01',
        topItems: [
          { menuItemId: 'l', name: 'Latte', quantity: 6, revenueMinor: 60 },
          {
            menuItemId: 'l',
            name: 'Caffè Latte',
            quantity: 3,
            revenueMinor: 30,
          },
        ],
      },
    ];

    expect(mergeTopItems(renamed, 10)).toEqual([
      { menuItemId: 'l', name: 'Caffè Latte', quantity: 9, revenueMinor: 90 },
    ]);
  });

  it('takes the display name from the most recent day that sold the item', () => {
    const renamedAcrossDays: DayItems[] = [
      {
        businessDay: '2026-06-02',
        topItems: [
          {
            menuItemId: 'l',
            name: 'Caffè Latte',
            quantity: 1,
            revenueMinor: 10,
          },
        ],
      },
      {
        businessDay: '2026-06-01',
        topItems: [
          { menuItemId: 'l', name: 'Latte', quantity: 1, revenueMinor: 10 },
        ],
      },
    ];

    // Input order is deliberately newest-first, to prove the name is chosen by
    // businessDay rather than by position in the array.
    expect(mergeTopItems(renamedAcrossDays, 10)[0].name).toBe('Caffè Latte');
  });

  it('orders by quantity descending, then by name', () => {
    const tied: DayItems[] = [
      {
        businessDay: '2026-06-01',
        topItems: [
          { menuItemId: 'b', name: 'Bun', quantity: 5, revenueMinor: 1 },
          { menuItemId: 'a', name: 'Americano', quantity: 5, revenueMinor: 2 },
          { menuItemId: 'c', name: 'Croissant', quantity: 9, revenueMinor: 3 },
        ],
      },
    ];

    expect(mergeTopItems(tied, 10).map((i) => i.name)).toEqual([
      'Croissant',
      'Americano',
      'Bun',
    ]);
  });

  it('applies the limit after merging, not before', () => {
    expect(mergeTopItems(days, 1)).toEqual([
      { menuItemId: 'latte', name: 'Latte', quantity: 15, revenueMinor: 150 },
    ]);
  });

  it('returns empty for a range with no sales', () => {
    expect(mergeTopItems([], 10)).toEqual([]);
  });
});
