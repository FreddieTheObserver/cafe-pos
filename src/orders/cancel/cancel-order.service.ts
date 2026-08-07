import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders, payments } from '../../database/schema';
import type { OrderStatus, PaymentStatus } from '../../database/schema/enums';
import type { Principal } from '../../identity/principal';
import { OrderAlreadyPaidError } from '../../payments/errors/payments.errors';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../../payments/provider/payment-provider';
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

/** The statuses `one_live_payment` treats as live — an intent still in flight. */
const LIVE: readonly PaymentStatus[] = ['PENDING', 'PROCESSING'];

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
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async cancel(
    principal: Principal,
    orderId: string,
    reason?: string | null,
  ): Promise<OrderSummary> {
    /**
     * Scoped in the lookup, so a device asking about another tablet's order
     * gets the same 404 as one asking about an order that never existed
     * (§5.4). A role check could only have said 403, which tells the caller
     * the order is real.
     */
    const current = await this.db.query.orders.findFirst({
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

    /**
     * The gateway is asked before the order moves — the same E3 handling the
     * expiry sweep does, for the same reason and one door along.
     *
     * From Phase 4 a `PENDING_PAYMENT` order can have a live intent behind it,
     * and this is the *other* way out of that state. Cancelling the order
     * without cancelling the intent leaves it live at Stripe: the customer can
     * still confirm the QR they are holding, the money is captured, and the
     * webhook then finds a CANCELLED order and refuses — money taken, no order
     * to fulfil, and only the nightly reconciliation to notice.
     *
     * Read and cancelled outside the transaction below, because it is a network
     * round trip and must not be held open across one.
     */
    const [live] = await this.db
      .select({ id: payments.id, intentId: payments.providerIntentId })
      .from(payments)
      .where(
        and(eq(payments.orderId, orderId), inArray(payments.status, LIVE)),
      );

    if (live?.intentId != null) {
      // Lost the race: the customer confirmed while this was in flight. The
      // cancel does not proceed, and the webhook marks the order PAID.
      if (
        (await this.provider.cancelIntent(live.intentId)) ===
        'ALREADY_SUCCEEDED'
      ) {
        throw new OrderAlreadyPaidError();
      }
    }

    return this.db.transaction(async (tx) => {
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

      // Not left live, or B4 would refuse the customer a fresh order.
      if (live !== undefined) {
        await tx
          .update(payments)
          .set({ status: 'CANCELLED' })
          .where(eq(payments.id, live.id));
      }

      return toOrderSummary(updated);
    });
  }
}
