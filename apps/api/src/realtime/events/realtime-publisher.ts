import { Logger } from '@nestjs/common';
import type { DomainEvent } from './domain-event';

/**
 * The seam between "an order moved" and "a screen was told".
 *
 * A port for the same reason `PaymentProvider` is one: the domain services
 * should not import Socket.IO, and the after-commit machinery has to be
 * testable without a server, a Redis, or a socket.
 */
export interface RealtimePublisher {
  publish(events: DomainEvent[]): Promise<void>;
}

/**
 * The default until the gateway lands, and the implementation every unit test
 * gets. Logs at debug so a misrouted event during development is visible
 * without pretending delivery happened.
 */
export class LoggingRealtimePublisher implements RealtimePublisher {
  private readonly logger = new Logger('RealtimePublisher');

  publish(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.logger.debug(`${event.kind} order=${event.orderId} (not delivered)`);
    }
    return Promise.resolve();
  }
}
