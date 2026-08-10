import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders, payments } from '../../database/schema';
import type {
  OrderChannel,
  OrderStatus,
  PaymentMethod,
} from '../../database/schema/enums';
import type { Principal } from '../../identity/principal';
import { decodeCursor, encodeCursor } from './cursor';
import type { OrderSort } from './orders-query.dto';

/** A row of the order list — everything a lookup screen shows, and no lines. */
export interface OrderSummary {
  id: string;
  /** Null while the order is a parked DRAFT — checkout assigns it (B3). */
  orderNumber: string | null;
  status: string;
  channel: string;
  businessDay: string;
  customerName: string | null;
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  currency: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface OrderPage {
  orders: OrderSummary[];
  /** Null on the last page — the client stops when it stops being handed one. */
  nextCursor: string | null;
}

export interface OrdersQuery {
  status?: OrderStatus[];
  channel?: OrderChannel[];
  method?: PaymentMethod[];
  from?: string;
  to?: string;
  businessDay?: string;
  q?: string;
  sort: OrderSort;
  limit: number;
  cursor?: string;
}

/** One line of the audit trail (FR-22). */
export interface OrderStatusChange {
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  actorId: string | null;
  createdAt: string;
}

/** One line of an order, with the option snapshots that priced it. */
export interface OrderLine {
  nameSnapshot: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  notes: string | null;
  options: { group: string; name: string; priceDeltaMinor: number }[];
}

export interface OrderDetail extends OrderSummary {
  items: OrderLine[];
  statusHistory: OrderStatusChange[];
}

const SUMMARY_COLUMNS = {
  id: orders.id,
  orderNumber: orders.orderNumber,
  status: orders.status,
  channel: orders.channel,
  businessDay: orders.businessDay,
  customerName: orders.customerName,
  subtotalMinor: orders.subtotalMinor,
  vatMinor: orders.vatMinor,
  totalMinor: orders.totalMinor,
  currency: orders.currency,
  createdAt: orders.createdAt,
  expiresAt: orders.expiresAt,
} as const;

/**
 * Reading orders back (§5.2, §5.6).
 *
 * Split from `OrdersService` because the two have nothing in common but a
 * table: writing an order is a money path guarded by pricing and a state
 * machine, while reading one is a query builder. Keeping them apart means the
 * filter surface can grow without enlarging the file where the money lives.
 */
@Injectable()
export class OrdersReadService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The order list, cursor-paginated (§5.1).
   *
   * Cursor rather than offset, and §5.1 gives the reason: `OFFSET 50000`
   * degrades linearly, and — worse for a POS — a new order arriving mid-scroll
   * shifts every subsequent page, so a cashier looking for a customer's order
   * can page straight past it.
   */
  async list(query: OrdersQuery): Promise<OrderPage> {
    const [column, direction] = sortColumn(query.sort);

    const where = and(
      ...this.filters(query),
      ...(query.cursor === undefined
        ? []
        : [cursorPredicate(query.cursor, query.sort, column, direction)]),
    );

    /**
     * One row more than asked for, then dropped. It is the cheapest honest
     * answer to "is there a next page": counting the whole filtered set costs a
     * second scan, and issuing a cursor unconditionally would leave a client
     * fetching an empty page to discover the end.
     */
    const rows = await this.db
      .select(SUMMARY_COLUMNS)
      .from(orders)
      .where(where)
      .orderBy(direction(column), direction(orders.id))
      .limit(query.limit + 1);

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      orders: page.map(toOrderSummary),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor(query.sort, sortValueOf(last, query.sort), last.id)
          : null,
    };
  }

  /**
   * One order in full (§5.2).
   *
   * A kiosk may read only its own, and an order belonging to another device
   * answers **404, not 403** — §5.4 is explicit that an out-of-scope resource
   * must not be distinguishable from a missing one, or the error code itself
   * becomes a way to enumerate what the cafe sold today.
   */
  async detail(principal: Principal, id: string): Promise<OrderDetail> {
    const row = await this.db.query.orders.findFirst({
      where: and(
        eq(orders.id, id),
        ...(principal.type === 'device'
          ? [eq(orders.kioskDeviceId, principal.deviceId)]
          : []),
      ),
      with: {
        items: {
          with: { options: true },
        },
        statusHistory: true,
      },
    });

    if (!row) throw new ResourceNotFoundError('order', id);

    return {
      ...toOrderSummary(row),
      items: toOrderLines(row.items),
      // Oldest first: the history reads as the story of the order.
      statusHistory: [...row.statusHistory]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((entry) => ({
          fromStatus: entry.fromStatus,
          toStatus: entry.toStatus,
          actorType: entry.actorType,
          actorId: entry.actorId,
          createdAt: entry.createdAt.toISOString(),
        })),
    };
  }

  private filters(query: OrdersQuery): SQL[] {
    const clauses: SQL[] = [];

    if (query.status !== undefined) {
      clauses.push(inArray(orders.status, query.status));
    }
    if (query.channel !== undefined) {
      clauses.push(inArray(orders.channel, query.channel));
    }
    if (query.method !== undefined) {
      /**
       * "Paid by" means **a payment that succeeded**, not an attempt that
       * carried the method.
       *
       * The distinction is the whole filter. An order is one row but its
       * payments are many (B4 caps only the *live* ones), so a customer whose
       * card was declined and who then handed over cash leaves two rows behind.
       * Matching on any attempt would return that order under both `CARD` and
       * `CASH`, and a cashier reconciling the till against `?method=CARD` would
       * be counting money that never arrived. Only `SUCCEEDED` is money that
       * moved, which is also what the Z-report's `byMethod` totals count
       * (§5.3) — one definition of "paid by card" for the list and the report
       * rather than two that quietly disagree at close.
       *
       * It follows that an in-flight gateway payment matches nothing at all:
       * `payments.method` stays null until the terminal webhook names the rail,
       * and `NULL IN (...)` is NULL, never true. That is the right answer —
       * until the webhook lands, nobody can say how the order was paid.
       *
       * Correlated EXISTS rather than a join: a join would multiply the order
       * row by its payments and need a DISTINCT that the cursor's row-value
       * comparison would then have to survive. EXISTS stops at the first match
       * and drives off `payments_order_id_idx` (§7.3).
       */
      clauses.push(
        exists(
          this.db
            .select({ matched: sql`1` })
            .from(payments)
            .where(
              and(
                eq(payments.orderId, orders.id),
                eq(payments.status, 'SUCCEEDED'),
                inArray(payments.method, query.method),
              ),
            ),
        ),
      );
    }
    if (query.businessDay !== undefined) {
      clauses.push(eq(orders.businessDay, query.businessDay));
    }
    if (query.from !== undefined && query.to !== undefined) {
      clauses.push(gte(orders.createdAt, new Date(query.from)));
      clauses.push(lte(orders.createdAt, new Date(query.to)));
    }
    if (query.q !== undefined) {
      /**
       * §5.6's two real lookups and nothing more: the order number a customer
       * reads off a slip, and the name a cashier half-remembers. The prefix
       * match is anchored so it can use `orders_customer_name_idx`; a leading
       * wildcard could not, and full-text search over order rows would be
       * machinery for a question nobody asks.
       */
      clauses.push(
        // Written as one template rather than through `or()`, which is typed
        // as possibly-undefined for the all-arguments-absent case that cannot
        // happen here — and the explicit parentheses make it obvious that the
        // alternation binds before the AND with every other filter.
        sql`(${orders.orderNumber} = ${query.q} or ${orders.customerName} ilike ${
          escapeLikePrefix(query.q) + '%'
        })`,
      );
    }

    return clauses;
  }
}

/**
 * Neutralises the wildcards a customer name could carry into a LIKE pattern.
 *
 * Without this, a `q` of `%` matches every named order in the cafe — not a
 * disclosure a staff-only endpoint frets about, but a needless full scan, and
 * the same habit on a public route is how these become real.
 */
const escapeLikePrefix = (value: string): string =>
  value.replace(/[\\%_]/g, (match) => `\\${match}`);

const sortColumn = (sort: OrderSort) =>
  [
    sort.endsWith('totalMinor') ? orders.totalMinor : orders.createdAt,
    sort.startsWith('-') ? desc : asc,
  ] as const;

const sortValueOf = (
  row: { createdAt: Date; totalMinor: number },
  sort: OrderSort,
): string =>
  sort.endsWith('totalMinor')
    ? String(row.totalMinor)
    : row.createdAt.toISOString();

/**
 * Resumes after the cursor's row using a row-value comparison.
 *
 * `(sort_col, id) < (value, id)` rather than a pair of ANDed comparisons: it is
 * the form Postgres can drive straight off a composite index, and — the reason
 * it matters here — it is correct when two orders share a timestamp, which at
 * peak they will. Comparing the sort column alone would drop whichever of them
 * fell on the page boundary.
 */
function cursorPredicate(
  raw: string,
  sort: OrderSort,
  column: typeof orders.createdAt | typeof orders.totalMinor,
  direction: typeof asc | typeof desc,
) {
  const { value, id } = decodeCursor(raw, sort);

  // Cast on the parameter rather than the column, so the index on the column
  // stays usable.
  const typed =
    column === orders.totalMinor
      ? sql`${Number(value)}::integer`
      : sql`${value}::timestamptz`;

  return direction === desc
    ? sql`(${column}, ${orders.id}) < (${typed}, ${id}::uuid)`
    : sql`(${column}, ${orders.id}) > (${typed}, ${id}::uuid)`;
}

/**
 * The line projection, shared by order detail and the KDS snapshot.
 *
 * Extracted for the same reason `toOrderSummary` exists: a barista's ticket and
 * a manager's order screen must not describe the same drink differently, and
 * two copies of this mapping is how that starts. §5.5 makes it load-bearing —
 * WS events carry full snapshots, so the event payload and the snapshot
 * endpoint have to agree column for column or a reconnecting screen would
 * repaint differently than it rendered.
 */
export const toOrderLines = (
  lines: {
    nameSnapshot: string;
    unitPriceMinorSnapshot: number;
    quantity: number;
    lineTotalMinor: number;
    notes: string | null;
    options: {
      groupNameSnapshot: string;
      optionNameSnapshot: string;
      priceDeltaMinorSnapshot: number;
    }[];
  }[],
): OrderLine[] =>
  lines.map((line) => ({
    nameSnapshot: line.nameSnapshot,
    unitPriceMinor: line.unitPriceMinorSnapshot,
    quantity: line.quantity,
    lineTotalMinor: line.lineTotalMinor,
    notes: line.notes,
    options: line.options.map((option) => ({
      group: option.groupNameSnapshot,
      name: option.optionNameSnapshot,
      priceDeltaMinor: option.priceDeltaMinorSnapshot,
    })),
  }));

/**
 * The summary projection, shared by every route that hands back an order
 * without its lines — the list, a status change, a cancellation. One function
 * so a column added to the shape appears in all of them at once.
 */
export const toOrderSummary = (row: {
  id: string;
  orderNumber: string | null;
  status: string;
  channel: string;
  businessDay: string;
  customerName: string | null;
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  currency: string;
  createdAt: Date;
  expiresAt: Date | null;
}): OrderSummary => ({
  id: row.id,
  orderNumber: row.orderNumber,
  status: row.status,
  channel: row.channel,
  businessDay: row.businessDay,
  customerName: row.customerName,
  subtotalMinor: row.subtotalMinor,
  vatMinor: row.vatMinor,
  totalMinor: row.totalMinor,
  currency: row.currency,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
});
