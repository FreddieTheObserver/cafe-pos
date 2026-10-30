import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import { orders } from '../../database/schema';
import { AfterCommit } from '../../realtime/events/after-commit.service';
import type { OrderStatus } from '../../database/schema/enums';
import type { Principal } from '../../identity/principal';
import { OrderInvalidTransitionError } from '../errors/orders.errors';
import {
  toOrderSummary,
  type OrderSummary,
} from '../query/orders-read.service';
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
  constructor(private readonly afterCommit: AfterCommit) {}

  async transition(
    principal: Principal,
    orderId: string,
    to: OrderStatus,
  ): Promise<OrderSummary> {
    return this.afterCommit.run(async (tx, emit) => {
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

      /**
       * §5.2 names `order.ready` separately from `order.updated`, and it earns
       * the distinction: every other move is one screen catching up with
       * another, while READY is the moment a customer can be called. A client
       * that wants to chime does not want to chime four times per order.
       */
      emit({
        kind: to === 'READY' ? 'order.ready' : 'order.updated',
        orderId,
        deviceId: updated.kioskDeviceId,
      });

      return toOrderSummary(updated);
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
