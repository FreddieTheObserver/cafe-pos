import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersReadService } from './query/orders-read.service';
import { OrderStatusService } from './state/order-status.service';
import { CancelOrderService } from './cancel/cancel-order.service';
import { CheckoutOrderService } from './checkout/checkout-order.service';
import { OrderExpiryService } from './expiry/order-expiry.service';
import { PaymentsModule } from '../payments/payments.module';

/**
 * Phase 3 (§17): the order pipeline — server-side pricing, snapshots, queue
 * numbers and the state machine every later phase leans on.
 *
 * `PaymentsModule` is the one import, and it is Phase 4 reaching back: the
 * expiry sweep has to cancel the intent behind an order before reclaiming it
 * (E3), because only the gateway knows whether the customer paid in the last
 * second. Nothing flows the other way — `PaymentsModule` uses this module's
 * free functions (`transitionOrder`, the idempotency store) by file, never by
 * injection — so the graph stays acyclic.
 *
 * Otherwise no imports, for the reason `CatalogModule` states: `DatabaseModule`
 * is `@Global`, `ConfigModule` is registered globally in `AppModule`, and
 * `IdentityModule` installs the auth and role guards globally — so a route
 * added here is guarded from the moment it exists, and `RolesGuard` refuses it
 * until someone declares who may call it.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrdersReadService,
    OrderStatusService,
    CancelOrderService,
    CheckoutOrderService,
    OrderExpiryService,
  ],
})
export class OrdersModule {}
