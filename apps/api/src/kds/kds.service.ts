import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../database/database.module';
import { DRIZZLE } from '../database/drizzle.constants';
import { orders } from '../database/schema';
import type { OrderStatus } from '../database/schema/enums';
import {
  toOrderLines,
  toOrderSummary,
  type OrderLine,
  type OrderSummary,
} from '../orders/query/orders-read.service';

/** A ticket on the bar screen: the order, plus what has to be made. */
export interface KdsTicket extends OrderSummary {
  items: OrderLine[];
}

/**
 * What the kitchen is working on right now (§5.2).
 *
 * `PAID` heads the list rather than `IN_PREPARATION`, because a ticket nobody
 * has started yet is precisely the one a barista most needs to see. The
 * terminal states fall off the board: the KDS is a worklist, not a history, and
 * §5.2 gives `GET /orders` for the history.
 */
export const KDS_STATUSES = [
  'PAID',
  'IN_PREPARATION',
  'READY',
] as const satisfies readonly OrderStatus[];

/**
 * A defensive ceiling, not pagination.
 *
 * §5.1 paginates order *history* because it grows without bound; the active
 * worklist does not — at 30 orders/minute peak (§11.1) a board this long
 * already means the kitchen has stopped, and a barista scrolling page two of a
 * KDS is a UX that has failed anyway. The cap exists so a stuck expiry job or a
 * forgotten pile of READY tickets degrades into a truncated board rather than a
 * query that hydrates every line item the cafe has ever sold.
 */
const MAX_TICKETS = 200;

@Injectable()
export class KdsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The snapshot the KDS renders on load, and re-fetches on reconnect.
   *
   * §5.5 makes this the recovery path for missed events — there is no resync
   * protocol, a client that fell behind simply calls this again — which is what
   * lets the realtime layer be best-effort rather than guaranteed delivery.
   *
   * Oldest first: the board is a queue, and the drink that has waited longest
   * is the one that should be made next. `id` breaks the tie because UUIDv7 is
   * time-ordered, so two orders sharing a timestamp still come back in the
   * order they were taken rather than in whatever order the scan found them.
   */
  async snapshot(): Promise<KdsTicket[]> {
    const rows = await this.db.query.orders.findMany({
      where: inArray(orders.status, [...KDS_STATUSES]),
      orderBy: [asc(orders.createdAt), asc(orders.id)],
      limit: MAX_TICKETS,
      with: { items: { with: { options: true } } },
    });

    return rows.map((row) => ({
      ...toOrderSummary(row),
      items: toOrderLines(row.items),
    }));
  }

  /**
   * One order in the board's shape, whatever status it is in.
   *
   * Deliberately *not* filtered to `KDS_STATUSES`, unlike the snapshot. §5.5
   * has events carry full snapshots so a client can always render from the
   * latest one, and that has to include the event that takes a ticket *off*
   * the board: a cancelled order the KDS never hears about stays on the screen
   * until someone reloads, which is how a barista makes a drink nobody is
   * waiting for. The client decides what to show; the server just says what the
   * order now is.
   *
   * Read after the commit that caused the event, so the snapshot is what the
   * database actually holds rather than what the caller believed it wrote.
   */
  async ticketFor(orderId: string): Promise<KdsTicket | null> {
    const row = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      with: { items: { with: { options: true } } },
    });

    if (!row) return null;

    return { ...toOrderSummary(row), items: toOrderLines(row.items) };
  }
}
