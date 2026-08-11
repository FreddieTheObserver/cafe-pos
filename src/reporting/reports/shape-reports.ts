import type { RollupItem, RollupRow } from '../rollup/build-rollup-row';

/** One bucket of `GET /reports/sales` (§5.2). */
export interface SalesBucket {
  /** `YYYY-MM-DD` for `groupBy=day`, `YYYY-MM-DDTHH` for `hour`. */
  bucket: string;
  revenueMinor: number;
  ordersSettled: number;
  avgTicketMinor: number | null;
}

/** One row of `GET /reports/top-items` (§5.2). */
export interface TopItem {
  menuItemId: string;
  name: string;
  quantity: number;
  revenueMinor: number;
}

/** A day's stored or freshly-computed item list, tagged with the day it is for. */
export interface DayItems {
  businessDay: string;
  topItems: readonly RollupItem[];
}

/**
 * Revenue per sale, rounded to the nearest satang.
 *
 * The only division near money in this codebase, and it is allowed because an
 * average ticket is a statistic rather than an amount anyone pays — no cash
 * changes hands over this number. Every value that *is* paid stays an integer
 * minor unit.
 *
 * Null rather than zero or Infinity when nothing was sold: a day with no sales
 * has no average ticket, and reporting `0` would be a claim about the size of
 * sales that did not happen.
 */
export function avgTicketMinor(
  revenueMinor: number,
  ordersSettled: number,
): number | null {
  if (ordersSettled <= 0) return null;
  return Math.round(revenueMinor / ordersSettled);
}

/** Projects a day's totals into a sales bucket. */
export function salesBucket(bucket: string, row: RollupRow): SalesBucket {
  return {
    bucket,
    revenueMinor: row.revenueMinor,
    ordersSettled: row.ordersSettled,
    avgTicketMinor: avgTicketMinor(row.revenueMinor, row.ordersSettled),
  };
}

/**
 * Merges per-day item lists into one leaderboard for the range.
 *
 * Keyed by `menuItemId`, never by name. The producer groups by
 * `(menu_item_id, name_snapshot)`, so an item renamed mid-service is two
 * entries in a single day's stored list; joining on the id rejoins them, and
 * the caller never sees the split. The display name is taken from the most
 * recent business day that sold the item, so a rename reads as a rename rather
 * than as two products.
 *
 * The limit is applied last. Truncating per day before merging is what makes a
 * range answer wrong — an item ranked eleventh every day can outsell a spiky
 * third — and it is the reason the producer stores every item sold rather than
 * a leaderboard.
 */
export function mergeTopItems(
  days: readonly DayItems[],
  limit: number,
): TopItem[] {
  const totals = new Map<string, TopItem & { nameFrom: string }>();

  for (const { businessDay, topItems } of days) {
    for (const item of topItems) {
      const running = totals.get(item.menuItemId);

      if (running === undefined) {
        totals.set(item.menuItemId, {
          menuItemId: item.menuItemId,
          name: item.name,
          quantity: item.quantity,
          revenueMinor: item.revenueMinor,
          nameFrom: businessDay,
        });
        continue;
      }

      running.quantity += item.quantity;
      running.revenueMinor += item.revenueMinor;

      // `>=` so a later entry within the *same* day also wins — that is the
      // renamed-mid-service case, where the newer name appears second.
      if (businessDay >= running.nameFrom) {
        running.name = item.name;
        running.nameFrom = businessDay;
      }
    }
  }

  return [...totals.values()]
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ menuItemId, name, quantity, revenueMinor }) => ({
      menuItemId,
      name,
      quantity,
      revenueMinor,
    }));
}
