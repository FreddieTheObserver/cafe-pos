import { Inject, Injectable } from '@nestjs/common';
import { asc, inArray } from 'drizzle-orm';
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
}
