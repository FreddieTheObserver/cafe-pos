import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersReadService } from './query/orders-read.service';
import { OrderStatusService } from './state/order-status.service';
import { CancelOrderService } from './cancel/cancel-order.service';
import { OrderExpiryService } from './expiry/order-expiry.service';

/**
 * Phase 3 (§17): the order pipeline — server-side pricing, snapshots, queue
 * numbers and the state machine every later phase leans on.
 *
 * No `imports`, for the reason `CatalogModule` states: `DatabaseModule` is
 * `@Global`, `ConfigModule` is registered globally in `AppModule`, and
 * `IdentityModule` installs the auth and role guards globally — so a route
 * added here is guarded from the moment it exists, and `RolesGuard` refuses it
 * until someone declares who may call it.
 */
@Module({
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrdersReadService,
    OrderStatusService,
    CancelOrderService,
    OrderExpiryService,
  ],
})
export class OrdersModule {}
