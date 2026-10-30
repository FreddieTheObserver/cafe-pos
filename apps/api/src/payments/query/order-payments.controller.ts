import { Controller, Get, Header, Param } from '@nestjs/common';
import { CurrentPrincipal } from '../../identity/decorators/current-principal.decorator';
import { Roles } from '../../identity/decorators/roles.decorator';
import type { Principal } from '../../identity/principal';
import { OrderIdParamDto } from '../../orders/orders.dto';
import {
  OrderPaymentsService,
  type PaymentAttemptView,
} from './order-payments.service';

/**
 * `GET /orders/:id/payments` (§5.2).
 *
 * A separate controller from the create path despite sharing the route: one
 * reads and one moves money, and §6.4 gives them different callers. BARISTA is
 * admitted here and not there — a bar screen may need to see why an order is
 * not paid, and it can never open a payment to find out.
 */
@Controller('orders/:id/payments')
export class OrderPaymentsController {
  constructor(private readonly payments: OrderPaymentsService) {}

  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'BARISTA', 'KIOSK')
  // Payment state is money state: a cached copy is a wrong answer (§11.4).
  @Header('Cache-Control', 'no-store')
  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Param() params: OrderIdParamDto,
  ): Promise<PaymentAttemptView[]> {
    return this.payments.listFor(principal, params.id);
  }
}
