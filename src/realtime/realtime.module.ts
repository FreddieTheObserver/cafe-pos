import { Global, Module } from '@nestjs/common';
import { REALTIME_PUBLISHER } from './realtime.constants';
import { AfterCommit } from './events/after-commit.service';
import { LoggingRealtimePublisher } from './events/realtime-publisher';

/**
 * Global because `AfterCommit` is infrastructure every write path reaches for,
 * the same way `DRIZZLE` is — the alternative is importing this module into
 * Orders, Payments and every module that later moves an order.
 *
 * The publisher stays a logging no-op until the gateway slice replaces it, so
 * this module can merge and be exercised before a single socket exists.
 */
@Global()
@Module({
  providers: [
    { provide: REALTIME_PUBLISHER, useClass: LoggingRealtimePublisher },
    AfterCommit,
  ],
  exports: [AfterCommit, REALTIME_PUBLISHER],
})
export class RealtimeModule {}
