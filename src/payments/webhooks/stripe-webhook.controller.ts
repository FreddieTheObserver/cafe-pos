import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../identity/decorators/public.decorator';
import { WebhookSignatureInvalidError } from '../errors/payments.errors';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../provider/payment-provider';
import { WebhookInboxService } from './webhook-inbox.service';

/**
 * Stripe's callback into this system (§4.2, §9.3).
 *
 * `@Public` because it has to be — Stripe holds no bearer token, and the
 * signature over the raw body is the authentication. That is the whole security
 * model of this route, which is why nothing here interprets the body until
 * `parseWebhook` has verified it.
 *
 * Deliberately *not* `@SkipThrottle`. The global backstop is 600/min and fails
 * open (`RATE_LIMITS.staffGeneral`), so it will never refuse a cafe's real
 * Stripe traffic and a Redis outage cannot cost us a payment — while an
 * unauthenticated public endpoint with no bound at all is a free HMAC oracle
 * for anyone who finds it.
 */
@Public()
@Controller('webhooks/stripe')
export class StripeWebhookController {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly inbox: WebhookInboxService,
  ) {}

  /**
   * Store, then ack (§9.3).
   *
   * 200 with a trivial body rather than 204: Stripe treats any 2xx as delivered,
   * and a body gives `stripe listen` and the Dashboard's delivery log something
   * to show that distinguishes "our endpoint answered" from "something in front
   * of it did".
   *
   * Nothing is *processed* here. Marking the order PAID reads the inbox row;
   * keeping that out of the request means a slow order transition can never
   * push this handler past Stripe's timeout and trigger a redelivery of an
   * event we already hold.
   */
  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const { rawBody } = request;

    /**
     * A wiring failure, not a bad request: it means the app was created
     * without `rawBody: true`, so *every* delivery would be unverifiable and
     * this endpoint would reject Stripe's own events as forgeries. A 500 that
     * names the cause beats a 400 that blames Stripe.
     */
    if (rawBody === undefined) {
      throw new Error(
        'No raw body on the webhook request — the app must be created with `rawBody: true`.',
      );
    }

    // Absent and wrong get the same answer (§10.1): the response never says
    // which check failed.
    if (signature === undefined) throw new WebhookSignatureInvalidError();

    const event = this.provider.parseWebhook(rawBody, signature);
    await this.inbox.record(event);

    return { received: true };
  }
}
