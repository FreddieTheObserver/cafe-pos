import { Global, Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { KdsModule } from '../kds/kds.module';
import { REALTIME_PUBLISHER } from './realtime.constants';
import { AfterCommit } from './events/after-commit.service';
import { SocketRealtimePublisher } from './events/socket-realtime.publisher';
import { KdsGateway } from './kds.gateway';
import { KioskGateway } from './kiosk.gateway';
import { RevocationSubscriber } from './revocation-subscriber.service';

/**
 * Global because `AfterCommit` is infrastructure every write path reaches for,
 * the same way `DRIZZLE` is — the alternative is importing this module into
 * Orders, Payments and every module that later moves an order.
 *
 * `IdentityModule` is imported rather than the gateway reaching for guards:
 * a WebSocket handshake is not an HTTP request, so the global `APP_GUARD`
 * chain never runs for it. The gateway therefore authenticates by calling
 * `AccessTokenService` itself, and that is a deliberate duplication of the
 * guard's job rather than an oversight — the two protocols genuinely differ,
 * and §5.5's "connection dropped on token revocation" has no HTTP counterpart.
 *
 * `KdsModule` supplies the snapshot shape the publisher pushes. The dependency
 * runs this way round on purpose — the board knows nothing about sockets, so
 * `GET /kds/orders` stays testable without one and the two surfaces cannot
 * drift into describing a ticket differently.
 */
@Global()
@Module({
  imports: [IdentityModule, KdsModule],
  providers: [
    { provide: REALTIME_PUBLISHER, useClass: SocketRealtimePublisher },
    AfterCommit,
    RevocationSubscriber,
    KdsGateway,
    KioskGateway,
  ],
  exports: [AfterCommit, REALTIME_PUBLISHER],
})
export class RealtimeModule {}
