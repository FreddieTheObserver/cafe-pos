import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import type { Env } from '../../config/env.validation';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders } from '../../database/schema';
import type { Principal } from '../../identity/principal';
import { OrderInvalidTransitionError } from '../errors/orders.errors';
import { nextOrderNumber } from '../order-number';
import {
  toOrderSummary,
  type OrderSummary,
} from '../query/orders-read.service';
import { transitionOrder } from '../state/transition-order';

/**
 * `POST /orders/:id/checkout` — a parked counter order joins the queue
 * (FR-7, §5.2).
 *
 * This is where B3's "assigned at checkout, not at draft" actually happens. A
 * draft holds no queue number and no expiry; committing to it claims both in
 * the same transaction that moves the status, so an order can never be seen
 * queued without a number or numbered without being queued.
 *
 * Deliberately does **not** re-price. §8 asks only that the order is a DRAFT
 * and the caller is staff, and re-pricing here would change the total a cashier
 * has already read out to the customer standing in front of them. The snapshot
 * taken when the basket was built is the quote the cafe gave; honouring it is
 * the point of snapshotting at all (FR-6).
 */
@Injectable()
export class CheckoutOrderService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async checkout(principal: Principal, orderId: string): Promise<OrderSummary> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query.orders.findFirst({
        where: eq(orders.id, orderId),
        columns: { status: true, businessDay: true },
      });
      if (current === undefined) {
        throw new ResourceNotFoundError('order', orderId);
      }
      if (current.status !== 'DRAFT') {
        throw new OrderInvalidTransitionError(
          current.status,
          'PENDING_PAYMENT',
        );
      }

      const updated = await transitionOrder(tx, {
        orderId,
        from: 'DRAFT',
        to: 'PENDING_PAYMENT',
        actor:
          principal.type === 'device'
            ? { actorType: 'DEVICE', actorId: principal.deviceId }
            : { actorType: 'USER', actorId: principal.userId },
      });

      /**
       * The number and the payment window are claimed after the guarded move,
       * not before, so a checkout that loses a race to another till burns
       * neither. `transitionOrder` has already thrown by this point if the
       * order was not still a DRAFT.
       *
       * The business day is the one stamped at creation, not today's. An order
       * parked at 04:55 and checked out at 05:05 belongs to the shift that took
       * it (B7) — recomputing here would move it to the next day's sequence and
       * its number could collide with one already called.
       */
      const [queued] = await tx
        .update(orders)
        .set({
          orderNumber: await nextOrderNumber(tx, current.businessDay),
          expiresAt: new Date(
            Date.now() +
              this.config.get('ORDER_EXPIRY_SECONDS', { infer: true }) * 1000,
          ),
        })
        .where(eq(orders.id, updated.id))
        .returning();

      return toOrderSummary(queued);
    });
  }
}
