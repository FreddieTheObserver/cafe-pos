import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import type { Transaction } from '../../orders/idempotency/idempotency.store';
import { REALTIME_PUBLISHER } from '../realtime.constants';
import type { DomainEvent } from './domain-event';
import type { RealtimePublisher } from './realtime-publisher';

/** Buffers an event for delivery *if and only if* the transaction commits. */
export type Emit = (event: DomainEvent) => void;

/**
 * Runs a transaction and publishes what it emitted, after it commits.
 *
 * The ordering is the whole point. `transitionOrder` is called from six places,
 * all inside a transaction, and any of them can still throw afterwards — a
 * refund that fails E9, an idempotency conflict, a constraint. Publishing from
 * inside would announce an order state that is about to be rolled back, and
 * because §5.5 makes missed-event recovery "call the snapshot endpoint", the
 * KDS has no mechanism to ever learn it was lied to. A *late* event is
 * self-correcting; a *false* one is not.
 *
 * This mirrors Phase 4's inbox discipline pointed the other way: there, store
 * before acknowledging; here, commit before announcing.
 */
@Injectable()
export class AfterCommit {
  private readonly logger = new Logger('AfterCommit');

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(REALTIME_PUBLISHER) private readonly publisher: RealtimePublisher,
  ) {}

  async run<T>(work: (tx: Transaction, emit: Emit) => Promise<T>): Promise<T> {
    const pending: DomainEvent[] = [];

    // A throw here propagates untouched and `pending` is simply dropped: the
    // rollback and the discarded events are the same control flow, so they
    // cannot disagree.
    const result = await this.db.transaction((tx) =>
      work(tx, (event) => {
        pending.push(event);
      }),
    );

    if (pending.length > 0) await this.flush(pending);

    return result;
  }

  /**
   * Delivery is best-effort and must never fail the caller.
   *
   * The money is already committed by this point. Turning a Redis blip into a
   * 500 would tell a cashier their perfectly good order failed, and would do it
   * *after* the customer was charged — the same fail-open reasoning the menu
   * cache and the `staffGeneral` throttler rule already use. The screens
   * reconcile on reconnect via the snapshot endpoint (§5.5); the customer
   * cannot un-pay.
   */
  private async flush(events: DomainEvent[]): Promise<void> {
    try {
      await this.publisher.publish(events);
    } catch (error) {
      this.logger.warn(
        `Committed but could not announce ${events.length} event(s); screens will resync from the snapshot. ${describe(error)}`,
      );
    }
  }
}

const describe = (error: unknown): string =>
  error instanceof Error && error.message.length > 0
    ? error.message
    : String(error);
