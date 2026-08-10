import { Injectable, Logger } from '@nestjs/common';
import { KdsService } from '../../kds/kds.service';
import { KdsGateway } from '../kds.gateway';
import type { DomainEvent } from './domain-event';
import type { RealtimePublisher } from './realtime-publisher';

/**
 * Which audience each event belongs to.
 *
 * `payment.succeeded` and `payment.failed` are absent on purpose: §5.2 sends
 * them to the *owning kiosk*, not to the bar, and that namespace does not exist
 * yet. They are dropped here rather than broadcast to staff, because a payment
 * event on the KDS is noise at best and, since it names another customer's
 * order, exactly the kind of leak the namespace split exists to prevent.
 */
const KDS_EVENTS = new Set<DomainEvent['kind']>([
  'order.paid',
  'order.updated',
  'order.ready',
]);

/**
 * Turns committed domain events into the pushes §5.2 promises.
 *
 * Replaces `LoggingRealtimePublisher` now that there is somewhere to publish.
 * The shape of the payload is the KDS ticket rather than a bespoke event body:
 * §5.5 requires full snapshots, and a screen that reconnects and calls
 * `GET /kds/orders` must not get a different shape than the one it has been
 * receiving live — otherwise the two render differently and the bug only shows
 * up after a network blip.
 */
@Injectable()
export class SocketRealtimePublisher implements RealtimePublisher {
  private readonly logger = new Logger('RealtimePublisher');

  constructor(
    private readonly kds: KdsService,
    private readonly gateway: KdsGateway,
  ) {}

  async publish(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      if (!KDS_EVENTS.has(event.kind)) continue;

      /**
       * Hydrated per event, after the commit. An order that vanished between
       * commit and publish is not an error worth failing over — it cannot
       * happen for an order that was just written, and if it somehow did, the
       * honest response is to say nothing rather than to push a half-empty
       * ticket a board would render as a blank row.
       */
      const ticket = await this.kds.ticketFor(event.orderId);
      if (ticket === null) {
        this.logger.warn(
          `Skipping ${event.kind}: order ${event.orderId} could not be read back.`,
        );
        continue;
      }

      this.gateway.broadcast(event.kind, ticket);
    }
  }
}
