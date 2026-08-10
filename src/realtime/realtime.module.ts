import { Global, Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { REALTIME_PUBLISHER } from './realtime.constants';
import { AfterCommit } from './events/after-commit.service';
import { LoggingRealtimePublisher } from './events/realtime-publisher';
import { KdsGateway } from './kds.gateway';

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
 * The publisher is still a logging no-op: this slice connects screens and
 * authenticates them, and the next one gives them something to receive.
 */
@Global()
@Module({
  imports: [IdentityModule],
  providers: [
    { provide: REALTIME_PUBLISHER, useClass: LoggingRealtimePublisher },
    AfterCommit,
    KdsGateway,
  ],
  exports: [AfterCommit, REALTIME_PUBLISHER],
})
export class RealtimeModule {}
