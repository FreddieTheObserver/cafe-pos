import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { describeError } from '../../common/errors/describe-error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders, paymentEvents, payments } from '../../database/schema';
import type { PaymentMethod, PaymentStatus } from '../../database/schema/enums';
import type { Transaction } from '../../orders/idempotency/idempotency.store';
import { transitionOrder } from '../../orders/state/transition-order';
import {
  PAYMENT_PROVIDER,
  type GatewayOutcome,
  type PaymentProvider,
} from '../provider/payment-provider';
import {
  decidePaymentOutcome,
  type PaymentDecision,
} from './decide-payment-outcome';

/**
 * How many inbox rows one tick drains.
 *
 * Same reasoning as the expiry sweep's cap: a cafe produces a handful of events
 * a minute, so this is only ever reached after an outage. Draining a backlog in
 * bounded batches keeps one tick from holding locks across `orders` while the
 * cafe is trying to trade; the rest is taken next tick.
 */
const MAX_PER_TICK = 100;

/**
 * Payment states a later event may not overwrite. Mirrors `SETTLED` in
 * `decide-payment-outcome.ts` — that one refuses the decision, this one refuses
 * the write when the decision was made against a stale read.
 */
const SETTLED_STATUSES: readonly PaymentStatus[] = ['SUCCEEDED'];

/**
 * The other half of §4.2: the inbox, drained.
 *
 * The webhook stores and acks; this decides what each stored event meant and
 * writes the consequences. Splitting them is what lets a slow order transition
 * — or a bug in one — not turn into a redelivery of an event already on disk.
 *
 * Every write here is guarded rather than coordinated. Two instances (§11.3)
 * run this sweep simultaneously and neither takes a lock: the loser's
 * `processed_at IS NULL` matches nothing, exactly as the expiry job's
 * `WHERE status = 'PENDING_PAYMENT'` does.
 */
@Injectable()
export class PaymentEventProcessor {
  private readonly logger = new Logger(PaymentEventProcessor.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * The safety net, not the main path.
   *
   * The webhook kicks processing the moment it has stored an event, so in
   * normal operation this finds nothing. It exists for what the kick cannot
   * cover: the process dying between the ack and the transition, and rows left
   * unprocessed on purpose by a `REFUSE` — which stay visible here until a
   * human resolves them, rather than being silently dropped.
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'drain-payment-inbox' })
  async drainInbox(): Promise<number> {
    let applied = 0;

    try {
      const pending = await this.db
        .select({ id: paymentEvents.id })
        .from(paymentEvents)
        .where(isNull(paymentEvents.processedAt))
        .limit(MAX_PER_TICK);

      for (const { id } of pending) {
        if (await this.processEvent(id)) applied += 1;
      }
    } catch (error) {
      // A sweep that cannot read the inbox is not a sweep that found nothing.
      this.logger.error(
        `Could not drain the payment inbox. ${describeError(error)}`,
      );
    }

    return applied;
  }

  /**
   * Processes one stored event, and says whether it changed anything.
   *
   * Never throws. The webhook calls this without awaiting it, so a rejection
   * here would surface as an unhandled promise rather than as a log line — and
   * the row is on disk either way, which is what the sweep above is for.
   */
  async processEvent(eventId: string): Promise<boolean> {
    try {
      return await this.apply(eventId);
    } catch (error) {
      this.logger.error(
        `Failed to process payment event ${eventId}; leaving it for the sweep. ${describeError(error)}`,
      );
      return false;
    }
  }

  private async apply(eventId: string): Promise<boolean> {
    const event = await this.db.query.paymentEvents.findFirst({
      where: and(
        eq(paymentEvents.id, eventId),
        isNull(paymentEvents.processedAt),
      ),
      columns: { id: true, payload: true },
    });
    // Already processed, or claimed by the other instance between the sweep's
    // scan and here. Both mean there is nothing left to do.
    if (event === undefined) return false;

    const outcome = this.provider.interpret(event.payload);
    const { payment, order } = await this.load(outcome);
    const decision = decidePaymentOutcome(outcome, payment, order);

    switch (decision.kind) {
      case 'REFUSE':
        /**
         * Logged and left unprocessed, deliberately. `processed_at` stays NULL
         * so the sweep keeps surfacing it — an event this system refused to act
         * on is not one it should forget, and the alternative is money moving
         * with nothing in the system that knows.
         */
        this.logger.error(
          `Refused payment event ${eventId}: ${decision.why} Left unprocessed for review.`,
        );
        return false;

      case 'SKIP':
        await this.markProcessed(eventId, payment?.id ?? null);
        return false;

      case 'MARK_PAYMENT':
        await this.db.transaction(async (tx) => {
          /**
           * Guarded on the status, not just the id — the same shape
           * `transitionOrder` uses on `orders.status`, and for the same reason.
           *
           * `decidePaymentOutcome` refuses to overwrite a settled payment, but
           * it judges a snapshot read *outside* this transaction. Dynamic
           * payment methods make the interleaving ordinary rather than exotic:
           * a customer whose card declines retries with PromptPay on the same
           * intent, so `payment_intent.payment_failed` and
           * `payment_intent.succeeded` arrive together and the controller kicks
           * both without awaiting. Both snapshots then say PENDING, and an
           * unguarded write lets the failure land after the success — leaving
           * `order = PAID, payment = FAILED` and a reconciliation delta at 3am.
           */
          await tx
            .update(payments)
            .set({ status: decision.status })
            .where(
              and(
                eq(payments.id, decision.paymentId),
                notInArray(payments.status, [...SETTLED_STATUSES]),
              ),
            );
          await this.markProcessed(eventId, decision.paymentId, tx);
        });
        return true;

      case 'MARK_PAID':
        return this.markPaid(eventId, decision);
    }
  }

  private async markPaid(
    eventId: string,
    decision: Extract<PaymentDecision, { kind: 'MARK_PAID' }>,
  ): Promise<boolean> {
    /**
     * Resolved before the transaction opens, never inside it. This is a network
     * round trip to Stripe, and holding a transaction — with the order row
     * locked — across one would let a slow gateway block the till. It is best
     * effort by contract: a null here costs the Z-report a row of per-method
     * detail, and refusing the payment over it would cost the customer their
     * coffee.
     */
    const method = await this.resolveMethod(decision);

    await this.db.transaction(async (tx) => {
      await transitionOrder(tx, {
        orderId: decision.orderId,
        from: 'PENDING_PAYMENT',
        to: 'PAID',
        // No user and no device: the gateway said so, not a person (FR-22).
        actor: { actorType: 'SYSTEM', actorId: null },
      });

      await tx
        .update(payments)
        .set({ status: 'SUCCEEDED', ...(method === null ? {} : { method }) })
        .where(eq(payments.id, decision.paymentId));

      await this.markProcessed(eventId, decision.paymentId, tx);
    });

    return true;
  }

  private async resolveMethod(
    decision: Extract<PaymentDecision, { kind: 'MARK_PAID' }>,
  ): Promise<PaymentMethod | null> {
    const [row] = await this.db
      .select({ intentId: payments.providerIntentId })
      .from(payments)
      .where(eq(payments.id, decision.paymentId));

    return row?.intentId == null
      ? null
      : this.provider.resolveMethod(row.intentId);
  }

  /** Loads our own side of the event: the payment it names, and its order. */
  private async load(outcome: GatewayOutcome) {
    if (outcome.kind === 'IGNORED')
      return { payment: undefined, order: undefined };

    const payment = await this.db.query.payments.findFirst({
      where: eq(payments.providerIntentId, outcome.intentId),
      columns: {
        id: true,
        orderId: true,
        amountMinor: true,
        currency: true,
        status: true,
      },
    });
    if (payment === undefined) return { payment: undefined, order: undefined };

    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, payment.orderId),
      columns: { id: true, status: true },
    });

    return { payment, order };
  }

  /**
   * Stamps the row, and back-fills the payment it turned out to be about.
   *
   * `processed_at IS NULL` in the WHERE is the idempotency: a replay, or the
   * other instance arriving a moment later, updates nothing.
   */
  private async markProcessed(
    eventId: string,
    paymentId: string | null,
    tx: Database | Transaction = this.db,
  ): Promise<void> {
    await tx
      .update(paymentEvents)
      .set({
        processedAt: new Date(),
        ...(paymentId === null ? {} : { paymentId }),
      })
      .where(
        and(eq(paymentEvents.id, eventId), isNull(paymentEvents.processedAt)),
      );
  }
}
