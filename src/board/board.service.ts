import { Inject, Injectable } from '@nestjs/common';
import { asc, inArray, isNotNull, and } from 'drizzle-orm';
import type { Database } from '../database/database.module';
import { DRIZZLE } from '../database/drizzle.constants';
import { orders } from '../database/schema';
import type { OrderStatus } from '../database/schema/enums';

/**
 * One line of the public board.
 *
 * A queue number and a state, and deliberately nothing else. §3.3.5 makes the
 * customer's name the *only* PII this system holds, and §5.2 marks this
 * audience PII-free — so `customerName` is not merely omitted from the
 * response, it is never selected. The order id is absent too: nobody standing
 * in the shop needs it, and a public identifier for an order is the beginning
 * of a way to ask the API about one.
 */
export interface BoardEntry {
  orderNumber: string;
  status: Extract<OrderStatus, 'IN_PREPARATION' | 'READY'>;
}

/**
 * What the screen above the counter shows (§5.2).
 *
 * `PAID` is absent, unlike the KDS. A customer does not want to watch a queue
 * of orders that have not been started; §5.2 says preparing and ready, which
 * is the part of the process they can act on — one means wait, the other means
 * come and collect.
 */
const BOARD_STATUSES = [
  'IN_PREPARATION',
  'READY',
] as const satisfies readonly OrderStatus[];

/** Same reasoning as the KDS ceiling: a bound, not pagination. */
const MAX_ENTRIES = 200;

@Injectable()
export class BoardService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async snapshot(): Promise<BoardEntry[]> {
    const rows = await this.db
      .select({ orderNumber: orders.orderNumber, status: orders.status })
      .from(orders)
      .where(
        and(
          inArray(orders.status, [...BOARD_STATUSES]),
          /**
           * Belt and braces. B3 assigns the number at checkout, so anything
           * this far along the state machine has one — but the column is
           * nullable (migration 0004) and a board rendering `null` as a queue
           * number is a worse failure than a row quietly missing.
           */
          isNotNull(orders.orderNumber),
        ),
      )
      .orderBy(asc(orders.createdAt), asc(orders.id))
      .limit(MAX_ENTRIES);

    return rows.map((row) => ({
      orderNumber: row.orderNumber as string,
      status: row.status as BoardEntry['status'],
    }));
  }
}
