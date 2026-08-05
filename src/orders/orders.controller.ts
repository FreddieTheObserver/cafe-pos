import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentPrincipal } from '../identity/decorators/current-principal.decorator';
import { Roles } from '../identity/decorators/roles.decorator';
import type { Principal } from '../identity/principal';
import { parseIdempotencyKey } from './idempotency/idempotency-key';
import {
  CancelOrderDto,
  CreateOrderDto,
  OrderIdParamDto,
  TransitionOrderDto,
} from './orders.dto';
import { CancelOrderService } from './cancel/cancel-order.service';
import { CheckoutOrderService } from './checkout/checkout-order.service';
import { OrdersQueryDto } from './query/orders-query.dto';
import {
  OrdersReadService,
  type OrderDetail,
  type OrderPage,
  type OrderSummary,
} from './query/orders-read.service';
import { OrdersService, type OrderView } from './orders.service';
import { OrderStatusService } from './state/order-status.service';

/**
 * Orders (§5.2, §6.4).
 *
 * The kiosk-first API §3.6 argues for, in one route: a tablet and a cashier
 * create orders through the same endpoint with the same pricing, and the
 * principal decides which of them is talking. A barista is absent from the
 * roles below because taking orders is not their job — they advance ones that
 * already exist, which is `POST /orders/:id/status`.
 */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly read: OrdersReadService,
    private readonly status: OrderStatusService,
    private readonly cancellation: CancelOrderService,
    private readonly checkout: CheckoutOrderService,
  ) {}

  /**
   * `Idempotency-Key` is read from the header rather than the body (§5.1)
   * because it describes the *attempt*, not the order — the same basket
   * submitted twice on purpose is two orders, and it is the key that says which
   * of the two a request means.
   *
   * `@Res({ passthrough: true })` so the handler can add a header and still
   * return a value: a replay must be flagged, and the alternative — an
   * interceptor reaching for a flag the service left somewhere — is a longer
   * way to say the same thing.
   */
  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'KIOSK')
  @Header('Cache-Control', 'no-store')
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderView> {
    const { order, replayed } = await this.orders.create(
      principal,
      body,
      parseIdempotencyKey(idempotencyKey),
    );

    // §5.7: the replay is a 201 carrying the original order, marked so a client
    // can tell "my retry worked" from "I just created a second order".
    if (replayed) res.setHeader('Idempotency-Replayed', 'true');
    return order;
  }

  /**
   * Staff only, deliberately. §5.2 gives a kiosk `GET /orders/:id` for its own
   * order and no list at all: a tablet in a public space has no business
   * holding a queryable history of what the cafe sold today, and it never needs
   * one — it knows the id of the order it just placed.
   */
  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'BARISTA')
  @Header('Cache-Control', 'no-store')
  @Get()
  list(@Query() query: OrdersQueryDto): Promise<OrderPage> {
    return this.read.list(query);
  }

  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'BARISTA', 'KIOSK')
  @Header('Cache-Control', 'no-store')
  @Get(':id')
  detail(
    @CurrentPrincipal() principal: Principal,
    @Param() params: OrderIdParamDto,
  ): Promise<OrderDetail> {
    return this.read.detail(principal, params.id);
  }

  /**
   * The KDS moving a ticket along (FR-16). Every staff role may, including
   * CASHIER — at a small cafe the person who hands the drink over is whoever
   * is free, and §6.4 gives all four the same three moves.
   *
   * 200, not 204: the response is the order in its new state, which is what
   * lets the screen that made the move re-render without a second request.
   */
  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'BARISTA')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post(':id/status')
  transition(
    @CurrentPrincipal() principal: Principal,
    @Param() params: OrderIdParamDto,
    @Body() body: TransitionOrderDto,
  ): Promise<OrderSummary> {
    return this.status.transition(principal, params.id, body.to);
  }

  /**
   * A parked counter order joining the queue (FR-7, §5.2).
   *
   * Staff only, and no kiosk: a device cannot create a draft, so it can never
   * have one to check out.
   */
  @Roles('ADMIN', 'MANAGER', 'CASHIER')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post(':id/checkout')
  checkoutOrder(
    @CurrentPrincipal() principal: Principal,
    @Param() params: OrderIdParamDto,
  ): Promise<OrderSummary> {
    return this.checkout.checkout(principal, params.id);
  }

  /**
   * Cancelling before payment (§5.2). A kiosk may cancel its own order — a
   * customer who walks away from the screen should not need a staff member —
   * and BARISTA is absent because a bar screen is not where an order is called
   * off.
   *
   * §5.2 also gives a manager post-payment cancellation. That path is Phase 4:
   * §4.4 routes it to `REFUNDED` rather than `CANCELLED`, and moving an order
   * to a terminal state while the customer's money is still with the gateway
   * is the exact failure this design exists to prevent.
   */
  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'KIOSK')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(
    @CurrentPrincipal() principal: Principal,
    @Param() params: OrderIdParamDto,
    @Body() body: CancelOrderDto,
  ): Promise<OrderSummary> {
    return this.cancellation.cancel(principal, params.id, body.reason);
  }
}
