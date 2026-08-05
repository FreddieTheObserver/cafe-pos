import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, lt } from 'drizzle-orm';
import { describeError } from '../../common/errors/describe-error';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import { OrderInvalidTransitionError } from '../errors/orders.errors';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders } from '../../database/schema';
import { transitionOrder } from '../state/transition-order';

/**
 * How many orders one tick will reap.
 *
 * A cafe abandons a handful of screens an hour, so this is never reached in
 * normal operation. It exists for the abnormal case — the job wedged for a day,
 * or a kiosk fault that left hundreds of baskets — where the alternative is one
 * transaction long enough to hold locks across the whole `orders` table while
 * the cafe is trying to trade. Whatever is left is taken on the next tick.
 */
const MAX_PER_TICK = 200;

/**
 * Whether this failure is the sweep losing a race it was always going to lose
 * sometimes, rather than something being wrong.
 *
 * Exactly two outcomes qualify, and both are the guard doing its job in the
 * window between the scan and the update: the order moved on (paid, cancelled)
 * so `WHERE status = 'PENDING_PAYMENT'` matched nothing, or it was deleted
 * outright. Exported so the discrimination is testable on real exception
 * instances instead of inferred from a log line.
 */
export const isLostRace = (error: unknown): boolean =>
  error instanceof OrderInvalidTransitionError ||
  error instanceof ResourceNotFoundError;

/**
 * Expiring unpaid orders (FR-10, §4.4).
 *
 * An order that reaches `PENDING_PAYMENT` holds a queue number and, from Phase
 * 4, a live payment intent. A customer who walks away from the screen leaves
 * both behind, so a job reclaims them — the state machine's one transition that
 * no human asks for.
 */
@Injectable()
export class OrderExpiryService {
  private readonly logger = new Logger(OrderExpiryService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Every minute. The TTL is ten (§5.7's sibling, `ORDER_EXPIRY_SECONDS`), so a
   * minute of granularity means an order is reclaimed between 10 and 11 minutes
   * after checkout — close enough for a queue number, and far cheaper than a
   * timer per order.
   *
   * Two instances (§11.3) both run this, and neither coordinates with the
   * other: the guarded transition makes a double run a no-op, because the
   * loser's `WHERE status = 'PENDING_PAYMENT'` matches nothing. That is
   * §9.3's "jobs are idempotent" holding without a distributed lock.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'expire-pending-orders' })
  async expireOverdue(): Promise<number> {
    let expired = 0;

    try {
      const overdue = await this.db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.status, 'PENDING_PAYMENT'),
            lt(orders.expiresAt, new Date()),
          ),
        )
        .limit(MAX_PER_TICK);

      /**
       * One transaction per order, not one for the batch. A single bad row —
       * a constraint that fires, a deadlock with a checkout — would otherwise
       * roll back every other expiry in the tick, and the job would make no
       * progress at all while the queue filled with dead numbers.
       */
      for (const { id } of overdue) {
        if (await this.expireOne(id)) expired += 1;
      }
    } catch (error) {
      // §9.3: log and let the next tick retry. Throwing from a cron handler
      // gets it swallowed by the scheduler anyway, and a job that dies on a
      // transient database blip is one nobody notices has stopped.
      this.logger.error(
        { err: describeError(error) },
        'order expiry sweep failed',
      );
    }

    if (expired > 0) this.logger.log(`expired ${expired} unpaid orders`);
    return expired;
  }

  private async expireOne(orderId: string): Promise<boolean> {
    try {
      await this.db.transaction((tx) =>
        transitionOrder(tx, {
          orderId,
          from: 'PENDING_PAYMENT',
          to: 'EXPIRED',
          // No user, no device: FR-22's third actor kind exists for exactly
          // this, so the history says the system reclaimed the order rather
          // than attributing it to whoever happened to be signed in.
          actor: { actorType: 'SYSTEM', actorId: null },
        }),
      );
      return true;
    } catch (error) {
      /**
       * Losing the race is the expected outcome, not a fault: the customer
       * paid, or a cashier cancelled, in the moment between the scan and the
       * update. The guard refuses, and there is nothing to report — logging it
       * would fill the log with the system working correctly.
       *
       * Anything else is a fault and says so. Treating every failure as a lost
       * race would let a deadlock, a broken connection or a constraint the
       * schema grew later stop the sweep making progress in total silence,
       * visible only to whoever thought to turn on debug logging.
       */
      if (isLostRace(error)) {
        this.logger.debug(
          { orderId, err: describeError(error) },
          'order was no longer expirable',
        );
        return false;
      }

      this.logger.error(
        { orderId, err: describeError(error) },
        'failed to expire order',
      );
      return false;
    }
  }
}
