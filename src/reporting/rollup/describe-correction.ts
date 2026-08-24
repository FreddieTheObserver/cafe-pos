import type { RollupRow } from './build-rollup-row';

/**
 * The scalar fields a late mutation can move.
 *
 * The two `jsonb` columns are deliberately not compared. `topItems` cannot
 * change without `revenueMinor` changing with it, and `revenueByMethod` sums
 * to `revenueMinor` by construction (`buildRollupRow`), so both are already
 * covered by a field in this list. Comparing them would mean a deep equality
 * check whose only unique verdict is one that cannot happen.
 */
const COMPARED_FIELDS = [
  'ordersCompleted',
  'ordersRefunded',
  'ordersCancelled',
  'ordersExpired',
  'ordersSettled',
  'revenueMinor',
  'refundsMinor',
  'vatMinor',
] as const;

type ComparedField = (typeof COMPARED_FIELDS)[number];

/**
 * What re-rolling an already-finalized day changed about it, or `null` if the
 * numbers came out identical.
 *
 * Pure, so the wording of the one log line that makes a silent correction
 * visible can be pinned without a database. `Pick` rather than `RollupRow` on
 * both sides so the stored row — which carries `finalizedAt` and the raw
 * `jsonb` columns — can be passed straight in.
 */
export function describeCorrection(
  previous: Pick<RollupRow, ComparedField>,
  next: Pick<RollupRow, ComparedField>,
): string | null {
  const moved = COMPARED_FIELDS.filter(
    (field) => previous[field] !== next[field],
  ).map((field) => `${field} ${previous[field]} → ${next[field]}`);

  return moved.length === 0 ? null : moved.join(', ');
}
