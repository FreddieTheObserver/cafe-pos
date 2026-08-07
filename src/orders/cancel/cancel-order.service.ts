import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { DependencyUnavailableError } from '../../common/errors/dependency-unavailable.error';
import { describeError } from '../../common/errors/describe-error';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders, payments } from '../../database/schema';
import type { OrderStatus, PaymentStatus } from '../../database/schema/enums';
import type { Principal } from '../../identity/principal';
import { OrderAlreadyPaidError } from '../../payments/errors/payments.errors';
import {
  PAYMENT_PROVIDER,
  type CancelIntentOutcome,
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
  private readonly logger = new Logger(CancelOrderService.name);

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
     *
     * Read outside the transaction below, unlike before Phase 4, because the
     * gateway call between here and there must not be made with one open. That
     * is safe rather than merely convenient: `transitionOrder` guards on
     * `WHERE status = :from`, so a status that goes stale in the gap makes the
     * update match nothing and raises, instead of being acted on. Do not move
     * this back inside without also moving `cancelIntent` out.
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
      let outcome: CancelIntentOutcome;

      try {
        outcome = await this.provider.cancelIntent(live.intentId);
      } catch (error) {
        /**
         * 503, not a 500, and the cancel does not proceed.
         *
         * Failing closed is the point: cancelling the order while the intent
         * is still live at Stripe is precisely the leak this block exists to
         * prevent, so an unreachable gateway must stop the request rather than
         * wave it through. 503 says the refusal was deliberate and retrying
         * works — a kiosk shows its offline screen instead of an engineer
         * being paged. Nothing is lost by waiting: an order nobody cancels
         * expires on its own, and the sweep cancels the intent then.
         */
        this.logger.error(
          `Could not cancel intent ${live.intentId} for order ${orderId}; refusing the cancellation. ${describeError(error)}`,
        );
        throw new DependencyUnavailableError(
          'The payment gateway could not be reached to cancel this order. Try again shortly.',
        );
      }

      // Lost the race: the customer confirmed while this was in flight. The
      // cancel does not proceed, and the webhook marks the order PAID.
      if (outcome === 'ALREADY_SUCCEEDED') throw new OrderAlreadyPaidError();
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

      /**
       * Not left live, or B4 would refuse the customer a fresh order.
       *
       * Guarded on the status as well as the id, matching the inbox
       * processor. Unreachable today — a `CANCELLED` outcome above means the
       * gateway had not taken the money, so no success can land in between —
       * but a guard costs one clause and this is the exact shape of the write
       * that let a stale decision overwrite a settled payment.
       */
      if (live !== undefined) {
        await tx
          .update(payments)
          .set({ status: 'CANCELLED' })
          .where(
            and(
              eq(payments.id, live.id),
              notInArray(payments.status, ['SUCCEEDED']),
            ),
          );
      }

      return toOrderSummary(updated);
    });
  }
}
