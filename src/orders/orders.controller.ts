import { Body, Controller, Header, Headers, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentPrincipal } from '../identity/decorators/current-principal.decorator';
import { Roles } from '../identity/decorators/roles.decorator';
import type { Principal } from '../identity/principal';
import { parseIdempotencyKey } from './idempotency/idempotency-key';
import { CreateOrderDto } from './orders.dto';
import { OrdersService, type OrderView } from './orders.service';

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
  constructor(private readonly orders: OrdersService) {}

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
}
