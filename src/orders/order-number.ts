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
