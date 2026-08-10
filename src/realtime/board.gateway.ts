import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Namespace } from 'socket.io';
import { NAMESPACES } from './realtime.constants';

/**
 * The public board's feed (§5.2).
 *
 * The one namespace with no connection gate at all, and the reason the three
 * audiences are separate namespaces rather than rooms sharing a handler: this
 * one is reachable by anybody on the network, so it must be impossible for it
 * to fall through to a branch that serves staff data. Here that is structural —
 * there is no authentication code in this file to get wrong, and nothing but
 * `BoardEntry` is ever emitted.
 *
 * No rooms either. Every screen shows the same board, so there is nothing to
 * scope, and no revocation to honour: an anonymous socket holds no credential
 * that could be taken away.
 */
@WebSocketGateway({ namespace: NAMESPACES.board })
export class BoardGateway {
  @WebSocketServer() private readonly server!: Namespace;

  /**
   * Pushes the whole board, not a delta.
   *
   * §5.5's rule, and it costs nothing here: the payload is a list of queue
   * numbers, so a client that reconnects mid-rush renders correctly from the
   * next event without a resync protocol or a call to the snapshot endpoint.
   */
  broadcast(entries: unknown): void {
    this.server.emit('board.updated', entries);
  }
}
