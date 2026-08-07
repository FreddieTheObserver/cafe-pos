import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sum } from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders, payments, refunds } from '../../database/schema';
import type { RefundStatus } from '../../database/schema/enums';
import type { StaffPrincipal } from '../../identity/principal';
import { businessDayOf } from '../../orders/business-day';
import { transitionOrder } from '../../orders/state/transition-order';
import {
  PaymentNotRefundableError,
  RefundExceedsRemainingError,
} from '../errors/payments.errors';

export interface CreateRefundInput {
  amountMinor: number;
  reason: string;
}

export interface RefundView {
  id: string;
  paymentId: string;
  amountMinor: number;
  reason: string;
  status: RefundStatus;
  /** True when this refund took the last of the captured amount (§4.4). */
  fullyRefunded: boolean;
}

/**
 * `POST /payments/:id/refunds` — refunding, as bookkeeping (§5.2, E9).
 *
 * **No money moves through the gateway.** §12.4 lists a `refund` verb and the
 * port deliberately has none: a PromptPay refund needs an email captured at
 * confirmation and the customer replying with the account they paid from, and
 * §7.5 minimises exactly that data. So staff settle from the till and this
 * writes the record.
 *
 * That does not make the arithmetic optional. `refunds.amount_minor` exists so
 * a partial refund is a record rather than a rounding of the order, and E9's
 * "no more than was captured" is a rule whoever hands over the cash. What is
 * absent is a `providerRefundId` — it stays null, because there is no gateway
 * refund to carry an id.
 */
@Injectable()
export class CreateRefundService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async refund(
    principal: StaffPrincipal,
    paymentId: string,
    input: CreateRefundInput,
  ): Promise<RefundView> {
    const payment = await this.db.query.payments.findFirst({
      where: eq(payments.id, paymentId),
      columns: { id: true, orderId: true, status: true, amountMinor: true },
    });
    if (payment === undefined) {
      throw new ResourceNotFoundError('payment', paymentId);
    }

    // Money that was never captured cannot be given back.
    if (payment.status !== 'SUCCEEDED') {
      throw new PaymentNotRefundableError(
        `Payment is ${payment.status}; only a SUCCEEDED payment can be refunded.`,
      );
    }

    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, payment.orderId),
      columns: { id: true, status: true, businessDay: true },
    });
    if (order === undefined) {
      throw new ResourceNotFoundError('order', payment.orderId);
    }

    /**
     * §3.3 confines a refund to the business day that took the money. A till
     * reconciled at close cannot be reopened by a refund against yesterday, and
     * the Z-report for a closed day must not move after it was read.
     */
    const today = businessDayOf(
      new Date(),
      this.config.get('BUSINESS_TIMEZONE', { infer: true }),
      this.config.get('BUSINESS_DAY_START_HOUR', { infer: true }),
    );
    if (order.businessDay !== today) {
      throw new PaymentNotRefundableError(
        `Order belongs to business day ${order.businessDay}; refunds are same-day only.`,
      );
    }

    return this.db.transaction(async (tx) => {
      /**
       * The payment row is locked, and the sum is read behind that lock.
       *
       * Two managers refunding the same payment at once would otherwise both
       * read the same "already refunded" and both pass E9 — and unlike a
       * payment there is no unique index to catch it, because a payment may
       * legitimately have many refunds. Locking the *parent* is what serialises
       * them: `FOR UPDATE` cannot be applied to an aggregate, and there are no
       * refund rows to lock on the first refund anyway.
       */
      await tx
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .for('update');

      const [{ refunded }] = await tx
        .select({ refunded: sum(refunds.amountMinor) })
        .from(refunds)
        .where(eq(refunds.paymentId, paymentId));

      const already = Number(refunded ?? 0);
      const remaining = payment.amountMinor - already;

      if (input.amountMinor > remaining) {
        throw new RefundExceedsRemainingError(input.amountMinor, remaining);
      }

      const [row] = await tx
        .insert(refunds)
        .values({
          paymentId,
          // Null, and it stays null: no gateway refund happened to have an id.
          providerRefundId: null,
          amountMinor: input.amountMinor,
          reason: input.reason,
          // Settled by the time it is recorded — the cash is out of the drawer.
          status: 'SUCCEEDED',
          initiatedByUserId: principal.userId,
        })
        .returning({ id: refunds.id });

      /**
       * §4.4: a partial refund leaves the order where it is and attaches a
       * record, so REFUNDED means *fully* refunded. Only the refund that takes
       * the last of the captured amount moves the order.
       */
      const fullyRefunded = already + input.amountMinor === payment.amountMinor;
      if (fullyRefunded) {
        await transitionOrder(tx, {
          orderId: order.id,
          from: order.status,
          to: 'REFUNDED',
          actor: { actorType: 'USER', actorId: principal.userId },
          reason: input.reason,
        });
      }

      return {
        id: row.id,
        paymentId,
        amountMinor: input.amountMinor,
        reason: input.reason,
        status: 'SUCCEEDED' as const,
        fullyRefunded,
      };
    });
  }
}
