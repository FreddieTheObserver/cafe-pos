import { sql } from 'drizzle-orm';
import { orderNumberCounters } from '../database/schema';
import type { Transaction } from './idempotency/idempotency.store';

/**
 * The short, human-sayable handle a barista calls across the room (FR-9, B3).
 *
 * Distinct from the order's UUID on purpose: nobody shouts a UUID, and the
 * customer holding a slip needs something they can read back. Unique per
 * business day and never recycled within one — the unique index on
 * `(business_day, order_number)` is what actually enforces that; this is only
 * the formatting.
 *
 * Three digits keeps the common case aligned on a slip while letting a busy day
 * run past 999 (`A-1000`) rather than wrapping into a number already called.
 */
const QUEUE_PREFIX = 'A';
const QUEUE_DIGITS = 3;

export const formatOrderNumber = (sequence: number): string =>
  `${QUEUE_PREFIX}-${String(sequence).padStart(QUEUE_DIGITS, '0')}`;

/**
 * Claims the next queue number for a business day (B3).
 *
 * One statement, and an upsert rather than a read-then-write because two kiosks
 * checking out in the same second is the normal case at peak, not an edge one.
 * `ON CONFLICT DO UPDATE` makes the counter row's own lock the serialization
 * point: the losing transaction waits for the winner to commit and then reads
 * the incremented value. No duplicates, and no application-level lock to get
 * wrong.
 *
 * A counter table rather than a Postgres sequence, and that is the whole reason
 * it exists. A sequence is deliberately non-transactional — it would keep
 * counting through a rolled-back checkout and leave A-041 permanently missing.
 * This increment rolls back with the order it was for, which is what makes B3's
 * "unique per business day" also gapless.
 *
 * The cost is real and bounded: because the lock is taken here and released at
 * commit, checkouts on the same business day serialize across the statements
 * that follow. At §3.5's peak of ~6 orders a minute that is nothing, and it is
 * the reason those statements are kept few.
 *
 * Called from both doors that produce a queue number — creating an order that
 * goes straight to PENDING_PAYMENT, and checking out a parked DRAFT.
 */
export async function nextOrderNumber(
  tx: Transaction,
  businessDay: string,
): Promise<string> {
  const [counter] = await tx
    .insert(orderNumberCounters)
    .values({ businessDay, lastValue: 1 })
    .onConflictDoUpdate({
      target: orderNumberCounters.businessDay,
      set: { lastValue: sql`${orderNumberCounters.lastValue} + 1` },
    })
    .returning({ lastValue: orderNumberCounters.lastValue });

  return formatOrderNumber(counter.lastValue);
}
