import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders } from '../../database/schema';
import type { OrderStatus } from '../../database/schema/enums';
import type { Principal } from '../../identity/principal';
import { OrderInvalidTransitionError } from '../errors/orders.errors';
import type { OrderSummary } from '../query/orders-read.service';
import { isStaffTransition } from './order-state';
import { transitionOrder } from './transition-order';

/**
 * `POST /orders/:id/status` — the KDS moving a ticket along (FR-16, §5.2).
 *
 * Three transitions, all of them a barista's: start preparing, mark ready, hand
 * it over. The narrowness is the design (§6.4). Payment, refunds, expiry and
 * cancellation each have their own door with their own authorization, and
 * folding them into a generic "set the status" endpoint would mean a barista's
 * token could mark an order paid.
 */
@Injectable()
export class OrderStatusService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async transition(
    principal: Principal,
    orderId: string,
    to: OrderStatus,
  ): Promise<OrderSummary> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query.orders.findFirst({
        where: eq(orders.id, orderId),
        columns: { status: true },
      });
      if (current === undefined) {
        throw new ResourceNotFoundError('order', orderId);
      }

      /**
       * Checked before the update rather than left to the guard, because the
       * guard cannot tell "this order moved under you" from "you asked for
       * something this endpoint never permits". Both are 409s, but only the
       * first is worth a KDS retrying.
       */
      if (!isStaffTransition(current.status, to)) {
        throw new OrderInvalidTransitionError(current.status, to);
      }

      const updated = await transitionOrder(tx, {
        orderId,
        from: current.status,
        to,
        actor: actorOf(principal),
      });

      return toSummary(updated);
    });
  }
}

/**
 * A staff principal, always — §6.4 gives a kiosk no transition at all. The
 * `SYSTEM` actor exists for the expiry job and is never produced here.
 */
const actorOf = (principal: Principal) =>
  principal.type === 'device'
    ? { actorType: 'DEVICE' as const, actorId: principal.deviceId }
    : { actorType: 'USER' as const, actorId: principal.userId };

const toSummary = (row: typeof orders.$inferSelect): OrderSummary => ({
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
