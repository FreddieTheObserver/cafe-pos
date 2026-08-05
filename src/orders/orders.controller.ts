import { Body, Controller, Post } from '@nestjs/common';
import { CurrentPrincipal } from '../identity/decorators/current-principal.decorator';
import { Roles } from '../identity/decorators/roles.decorator';
import type { Principal } from '../identity/principal';
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

  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'KIOSK')
  @Post()
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateOrderDto,
  ): Promise<OrderView> {
    return this.orders.create(principal, body);
  }
}
