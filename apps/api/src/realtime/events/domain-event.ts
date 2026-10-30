/**
 * What happened, not what to render.
 *
 * §5.5 requires events to carry **full snapshots** rather than diffs, but the
 * snapshot is deliberately *not* captured here. A payload built inside the
 * transaction describes uncommitted state, and if the transaction then rolls
 * back the KDS has been told about an order that does not exist. The publisher
 * re-reads after commit instead, so what goes on the wire is by construction
 * what the database actually holds.
 *
 * `deviceId` rides along because routing to the owning kiosk (§5.2) must not
 * cost a second query on a path that already knows the answer.
 */
export type DomainEvent =
  | { kind: 'order.paid'; orderId: string; deviceId: string | null }
  | { kind: 'order.updated'; orderId: string; deviceId: string | null }
  | { kind: 'order.ready'; orderId: string; deviceId: string | null }
  | {
      kind: 'payment.succeeded';
      orderId: string;
      deviceId: string | null;
      paymentId: string;
    }
  | {
      kind: 'payment.failed';
      orderId: string;
      deviceId: string | null;
      paymentId: string;
    };

export type DomainEventKind = DomainEvent['kind'];
