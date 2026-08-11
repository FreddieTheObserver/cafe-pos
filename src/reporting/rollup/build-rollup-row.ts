import type { OrderStatus, PaymentMethod } from '../../database/schema/enums';

/**
 * Where money whose rail could not be resolved is counted.
 *
 * `payments.method` is nullable (migration 0005) because the webhook fills it
 * and resolution is allowed to fail — the reconciliation service records that
 * a coffee is worth more than a label. That money is still revenue, so it needs
 * a bucket: dropping it would leave the method breakdown silently short of the
 * total it is supposed to account for, which is the one thing a Z-report exists
 * to prevent.
 */
export const UNKNOWN_METHOD = 'UNKNOWN';

/** One entry per menu item that sold on the day (§5.2 top-items). */
export interface RollupItem {
  menuItemId: string;
  name: string;
  quantity: number;
  revenueMinor: number;
}

/** The five queries' results, already converted to numbers. */
export interface RollupParts {
  statusCounts: readonly { status: OrderStatus; count: number }[];
  revenueByMethod: readonly {
    method: PaymentMethod | null;
    totalMinor: number;
  }[];
  refundsMinor: number;
  vatMinor: number;
  items: readonly RollupItem[];
}

/** One `daily_sales_rollups` row, ready to upsert. */
export interface RollupRow {
  businessDay: string;
  ordersCompleted: number;
  ordersRefunded: number;
  ordersCancelled: number;
  ordersExpired: number;
  revenueMinor: number;
  revenueByMethod: Record<string, number>;
  refundsMinor: number;
  vatMinor: number;
  topItems: RollupItem[];
}

/**
 * Assembles one finalized business day from its aggregate parts.
 *
 * Pure on purpose. Every rule that decides what a number means — which bucket
 * unresolved money lands in, what an absent status counts as, how the total
 * relates to its breakdown — lives here rather than in SQL, so it can be
 * exercised with plain objects and no database.
 */
export function buildRollupRow(
  businessDay: string,
  parts: RollupParts,
): RollupRow {
  const counts = new Map(
    parts.statusCounts.map(({ status, count }) => [status, count]),
  );

  const revenueByMethod: Record<string, number> = {};
  for (const { method, totalMinor } of parts.revenueByMethod) {
    const key = method ?? UNKNOWN_METHOD;
    revenueByMethod[key] = (revenueByMethod[key] ?? 0) + totalMinor;
  }

  /**
   * Summed from the buckets rather than queried separately, which is what makes
   * `Σ by_method === revenue_minor` true by construction. There is no assertion
   * here because there is no path by which it can be false.
   */
  const revenueMinor = Object.values(revenueByMethod).reduce(
    (total, amount) => total + amount,
    0,
  );

  /**
   * Sorted so two runs over the same closed day produce a byte-identical row —
   * which is what lets the idempotency test assert equality rather than
   * set-membership. Name breaks a quantity tie because `menuItemId` is a uuidv7
   * and would order by creation time, which is not a property of the day.
   */
  const topItems = [...parts.items].sort(
    (a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name),
  );

  return {
    businessDay,
    ordersCompleted: counts.get('COMPLETED') ?? 0,
    ordersRefunded: counts.get('REFUNDED') ?? 0,
    ordersCancelled: counts.get('CANCELLED') ?? 0,
    ordersExpired: counts.get('EXPIRED') ?? 0,
    revenueMinor,
    revenueByMethod,
    refundsMinor: parts.refundsMinor,
    vatMinor: parts.vatMinor,
    topItems,
  };
}
