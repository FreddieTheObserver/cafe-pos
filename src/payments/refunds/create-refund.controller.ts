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
import type { Principal, StaffPrincipal } from '../../identity/principal';
import {
  parseIdempotencyKey,
  REPLAY_HEADER,
} from '../../orders/idempotency/idempotency-key';
import { CreateRefundDto, PaymentIdParamDto } from './create-refund.dto';
import { CreateRefundService, type RefundView } from './create-refund.service';

/**
 * `POST /payments/:id/refunds` (§5.2, §6.4).
 *
 * MANAGER and ADMIN only — the one money-moving route a cashier cannot reach.
 * §6.4 puts it there because a refund is the single operation that takes cash
 * *out* of the till, and the person who took the payment should not be the
 * person who reverses it unsupervised.
 */
@Controller('payments/:id/refunds')
export class CreateRefundController {
  constructor(private readonly refunds: CreateRefundService) {}

  @Roles('ADMIN', 'MANAGER')
  @Header('Cache-Control', 'no-store')
  @HttpCode(201)
  @Post()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Param() params: PaymentIdParamDto,
    @Body() body: CreateRefundDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefundView> {
    /**
     * The role guard has already refused every device token, so a kiosk cannot
     * arrive here — but the narrowing has to be stated for the type system, and
     * asserting it makes the guard's guarantee explicit rather than assumed.
     */
    const { refund, replayed } = await this.refunds.refund(
      principal as StaffPrincipal,
      params.id,
      body,
      parseIdempotencyKey(idempotencyKey),
    );

    if (replayed) res.setHeader(REPLAY_HEADER, 'true');
    return refund;
  }
}
