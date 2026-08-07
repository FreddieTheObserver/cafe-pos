import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentPrincipal } from '../../identity/decorators/current-principal.decorator';
import { Roles } from '../../identity/decorators/roles.decorator';
import type { Principal } from '../../identity/principal';
import { parseIdempotencyKey } from '../../orders/idempotency/idempotency-key';
import { OrderIdParamDto } from '../../orders/orders.dto';
import {
  CreatePaymentService,
  type PaymentView,
} from './create-payment.service';
import { CreatePaymentDto } from './create-payment.dto';

/**
 * `POST /orders/:id/payments` (§5.2, FR-11).
 *
 * Lives in `PaymentsModule` rather than `OrdersModule` despite the path: the
 * route is about money and the gateway, and §17's phase boundary is what the
 * import graph should show. The nested path is the resource relationship, not a
 * statement about which module owns the behaviour.
 */
@Controller('orders/:id/payments')
export class CreatePaymentController {
  constructor(private readonly payments: CreatePaymentService) {}

  /**
   * KIOSK is allowed here and refused inside for CASH (B6). The role matrix
   * cannot express it: the same route serves the card and QR payments a kiosk
   * *may* open, and it is the method in the body that makes one forbidden.
   *
   * `no-store` because the response carries a client secret — the one value in
   * this system that authorises confirming a payment (§10.5).
   */
  @Roles('ADMIN', 'MANAGER', 'CASHIER', 'KIOSK')
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Param() params: OrderIdParamDto,
    @Body() body: CreatePaymentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentView> {
    const { payment, replayed } = await this.payments.create(
      principal,
      params.id,
      body,
      parseIdempotencyKey(idempotencyKey),
    );

    // Same signal `POST /orders` sets: a client that retried deserves to know
    // it got the original answer rather than a second payment.
    if (replayed) res.setHeader('Idempotent-Replay', 'true');

    return payment;
  }
}
