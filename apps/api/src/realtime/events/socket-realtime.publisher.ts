import { Injectable, Logger } from '@nestjs/common';
import { BoardService } from '../../board/board.service';
import { KdsService } from '../../kds/kds.service';
import { BoardGateway } from '../board.gateway';
import { KdsGateway } from '../kds.gateway';
import { KioskGateway } from '../kiosk.gateway';
import type { DomainEvent } from './domain-event';
import type { RealtimePublisher } from './realtime-publisher';

/**
 * Which audience hears what (§5.2).
 *
 * `order.ready` is in both, and that is the point rather than an oversight: the
 * bar marks a drink ready, and the customer waiting at the kiosk that ordered
 * it should be told at the same moment. Payment events are kiosk-only — a
 * payment on the bar screen is noise, and it names a customer's order.
 */
const KDS_EVENTS = new Set<DomainEvent['kind']>([
  'order.paid',
  'order.updated',
  'order.ready',
]);

const KIOSK_EVENTS = new Set<DomainEvent['kind']>([
  'payment.succeeded',
  'payment.failed',
  'order.ready',
]);

/**
 * What changes the public board.
 *
 * `order.paid` is absent: the board shows preparing and ready (§5.2), and a
 * paid order has reached neither. Every other order event either puts a queue
 * number on the board or takes one off.
 */
const BOARD_EVENTS = new Set<DomainEvent['kind']>([
  'order.updated',
  'order.ready',
]);

/**
 * Turns committed domain events into the pushes §5.2 promises.
 *
 * The payload is the KDS ticket for every audience rather than a shape per
 * namespace. §5.5 requires full snapshots, and a screen that reconnects and
 * calls `GET /kds/orders` must not get a different shape than the one it has
 * been receiving live — otherwise the two render differently and the bug only
 * shows up after a network blip. A kiosk reads fewer fields of the same
 * object; it is not sent a different object.
 */
@Injectable()
export class SocketRealtimePublisher implements RealtimePublisher {
  private readonly logger = new Logger('RealtimePublisher');

  constructor(
    private readonly kds: KdsService,
    private readonly board: BoardService,
    private readonly kdsGateway: KdsGateway,
    private readonly kioskGateway: KioskGateway,
    private readonly boardGateway: BoardGateway,
  ) {}

  async publish(events: DomainEvent[]): Promise<void> {
    let boardChanged = false;

    for (const event of events) {
      if (BOARD_EVENTS.has(event.kind)) boardChanged = true;
      const forKds = KDS_EVENTS.has(event.kind);
      /**
       * A counter order has no device to tell. Skipping rather than
       * broadcasting is what keeps the kiosk namespace scoped: a tablet must
       * only ever hear about the order it placed (§6.4).
       */
      const forKiosk = KIOSK_EVENTS.has(event.kind) && event.deviceId !== null;
      if (!forKds && !forKiosk) continue;

      /**
       * Hydrated once per event, after the commit. An order that vanished
       * between commit and publish cannot happen for one just written, and if
       * it somehow did the honest response is silence rather than a half-empty
       * ticket a board would render as a blank row.
       */
      const ticket = await this.kds.ticketFor(event.orderId);
      if (ticket === null) {
        this.logger.warn(
          `Skipping ${event.kind}: order ${event.orderId} could not be read back.`,
        );
        continue;
      }

      if (forKds) this.kdsGateway.broadcast(event.kind, ticket);
      if (forKiosk && event.deviceId !== null) {
        this.kioskGateway.emitToDevice(event.deviceId, event.kind, ticket);
      }
    }

    /**
     * Once per batch, not once per event. The board is a *list*, so two
     * transitions committed together produce one correct picture rather than
     * two queries and a flicker between them.
     */
    if (boardChanged) {
      this.boardGateway.broadcast(await this.board.snapshot());
    }
  }
}
