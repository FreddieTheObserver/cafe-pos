import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders } from '../../database/schema';
import type { OrderStatus } from '../../database/schema/enums';
import type { Principal } from '../../identity/principal';
import { OrderInvalidTransitionError } from '../errors/orders.errors';
import type { OrderSummary } from '../query/orders-read.service';
import { toOrderSummary } from '../query/orders-read.service';
import { transitionOrder } from '../state/transition-order';

/**
 * The states a cancellation may start from **in this phase**.
 *
 * §5.2 also gives a manager post-payment cancellation, from `PAID` through
 * `READY`. That is deliberately absent: §4.4 routes it to `REFUNDED`, not
 * `CANCELLED`, because money has changed hands — and the refund it depends on
 * is Phase 4's `PaymentProvider`. Shipping the transition without the refund
 * would move an order to a terminal state while the customer's money sat with
 * the gateway, which is the one class of bug this whole design is arranged to
 * prevent. Until then, cancelling a paid order is refused with the same
 * `ORDER_INVALID_TRANSITION` any other unavailable move gets.
 */
const CANCELLABLE: readonly OrderStatus[] = ['DRAFT', 'PENDING_PAYMENT'];

/**
 * `POST /orders/:id/cancel` (FR-8, §5.2).
 *
 * Separate from the KDS status route because the authorization is a different
 * shape: a kiosk may cancel — but only its own order, and only before it has
 * been paid for. That "own order" rule is a query filter rather than a role
 * check, which is exactly the kind of thing §6.3 argues belongs in the service
 * instead of in a guard.
 */
@Injectable()
export class CancelOrderService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async cancel(
    principal: Principal,
    orderId: string,
    reason?: string | null,
  ): Promise<OrderSummary> {
    return this.db.transaction(async (tx) => {
      /**
       * Scoped in the lookup, so a device asking about another tablet's order
       * gets the same 404 as one asking about an order that never existed
       * (§5.4). A role check could only have said 403, which tells the caller
       * the order is real.
       */
      const current = await tx.query.orders.findFirst({
        where: and(
          eq(orders.id, orderId),
          ...(principal.type === 'device'
            ? [eq(orders.kioskDeviceId, principal.deviceId)]
            : []),
        ),
        columns: { status: true },
      });
      if (current === undefined) {
        throw new ResourceNotFoundError('order', orderId);
      }

      if (!CANCELLABLE.includes(current.status)) {
        throw new OrderInvalidTransitionError(current.status, 'CANCELLED');
      }

      const updated = await transitionOrder(tx, {
        orderId,
        from: current.status,
        to: 'CANCELLED',
        actor:
          principal.type === 'device'
            ? { actorType: 'DEVICE', actorId: principal.deviceId }
            : { actorType: 'USER', actorId: principal.userId },
        reason,
      });

      return toOrderSummary(updated);
    });
  }
}
