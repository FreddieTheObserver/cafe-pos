import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { paymentEvents } from '../../database/schema/payments';
import type { GatewayEvent } from '../provider/payment-provider';

/**
 * The outcome of storing one delivery.
 *
 * `eventRowId` is null for a redelivery the unique index turned away. The
 * caller uses it to decide whether there is new work to kick off — processing
 * an event a previous delivery already stored is at best a no-op and at worst
 * two workers racing over one row.
 */
export interface InboxWrite {
  eventRowId: string | null;
}

/**
 * The §4.2 append-only inbox: every verified event is written down before
 * anything is done about it.
 *
 * Storing first is what makes the rest of the pipeline recoverable. If the
 * process dies between "Stripe told us" and "the order is PAID", the event is
 * still on disk and can be replayed; without the inbox that delivery is simply
 * lost, and Stripe's retries are the only copy — which run out.
 */
@Injectable()
export class WebhookInboxService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Writes the event, or does nothing if it is already there.
   *
   * `onConflictDoNothing` on `provider_event_id` is the dedupe (E4). Stripe
   * redelivers on any non-2xx and on network failures, so the *same* event id
   * arriving twice is routine rather than suspicious — and the second arrival
   * must not produce a second inbox row, or replaying the inbox would apply the
   * same payment twice.
   *
   * The uniqueness is enforced by the index, not by a read-then-write here: two
   * concurrent deliveries of one event would both see an empty table and both
   * insert. Letting Postgres arbitrate is the only version of this that is
   * correct under concurrency.
   */
  async record(event: GatewayEvent): Promise<InboxWrite> {
    const [row] = await this.db
      .insert(paymentEvents)
      .values({
        providerEventId: event.eventId,
        eventType: event.type,
        payload: event.payload,
      })
      .onConflictDoNothing({ target: paymentEvents.providerEventId })
      .returning({ id: paymentEvents.id });

    // No row back means the conflict fired: this delivery is a redelivery of
    // an event already stored, and the id of the row that won belongs to
    // whoever is processing it.
    return { eventRowId: row?.id ?? null };
  }
}
