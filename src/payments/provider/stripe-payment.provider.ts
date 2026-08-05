import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { describeError } from '../../common/errors/describe-error';
import type { PaymentMethod } from '../../database/schema/enums';
import { WebhookSignatureInvalidError } from '../errors/payments.errors';
import { STRIPE_CLIENT, STRIPE_WEBHOOK_SECRETS } from '../payments.constants';
import type {
  CancelIntentOutcome,
  CreateIntentRequest,
  CreatedIntent,
  GatewayEvent,
  GatewayOutcome,
  PaymentProvider,
} from './payment-provider';

/**
 * Stripe's rail names, mapped to ours.
 *
 * Only the two this cafe sells through. Anything else — a rail enabled in the
 * Dashboard that this schema has no enum for — resolves to null rather than
 * throwing, because the caller marks the order PAID either way (see
 * `resolveMethod` on the port).
 */
const METHOD_BY_STRIPE_TYPE: Readonly<Record<string, PaymentMethod>> = {
  card: 'CARD',
  promptpay: 'PROMPTPAY',
};

/**
 * The §12.4 port, spoken to Stripe.
 *
 * Everything Stripe-shaped stops here. Nothing above this file imports a
 * `Stripe.*` type, so the swap §3.5 anticipates — to Omise, 2C2P or
 * GBPrimePay if the merchant cannot get Stripe — is a sibling of this class
 * rather than an edit to the payment, webhook and expiry paths.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(StripePaymentProvider.name);

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    @Inject(STRIPE_WEBHOOK_SECRETS) private readonly secrets: readonly string[],
  ) {}

  async createIntent({
    amountMinor,
    currency,
    idempotencyKey,
    metadata,
  }: CreateIntentRequest): Promise<CreatedIntent> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: amountMinor,
        // Stripe wants the code lower-case; our column and config carry the
        // ISO 4217 upper-case form (§3.5).
        currency: currency.toLowerCase(),
        /**
         * Dynamic payment methods, which is what *not* naming
         * `payment_method_types` buys. Stripe's guidance is emphatic about
         * this: pinning the list freezes the accepted rails into deployed code
         * and opts out of the ranking that decides what a given customer sees.
         * Enabling PromptPay — or anything after it — is then a Dashboard
         * setting rather than a release.
         */
        automatic_payment_methods: { enabled: true },
        metadata: { ...metadata },
      },
      // Forwarded so the retry chain is idempotent end to end (§5.7): a kiosk
      // that times out and retries reaches the same intent instead of opening
      // a second one against the same basket.
      idempotencyKey === undefined ? undefined : { idempotencyKey },
    );

    if (intent.client_secret === null) {
      // Not reachable for a freshly created intent, but the SDK types it as
      // nullable and a null here would otherwise reach the kiosk as a broken
      // Payment Element rather than as an error.
      throw new Error(`Stripe returned no client secret for ${intent.id}`);
    }

    return { intentId: intent.id, clientSecret: intent.client_secret };
  }

  /**
   * Cancels an unpaid intent, and reports the lost race rather than throwing it.
   *
   * The outcome is decided by **re-reading the intent**, not by matching on an
   * error code. Stripe raises the same `payment_intent_unexpected_state` for
   * every state that forbids a cancel, so the code alone cannot tell "the
   * customer paid a second before the sweep" from "this was already cancelled"
   * — and those two mean opposite things to an order. This mirrors
   * `transitionOrder`'s `explainFailure`, which re-reads a row for the same
   * reason: a guess about why an operation failed is not worth acting on when
   * the truth is one query away.
   */
  async cancelIntent(intentId: string): Promise<CancelIntentOutcome> {
    try {
      await this.stripe.paymentIntents.cancel(intentId);
      return 'CANCELLED';
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeInvalidRequestError))
        throw error;

      const intent = await this.stripe.paymentIntents.retrieve(intentId);
      if (intent.status === 'succeeded') return 'ALREADY_SUCCEEDED';
      // Already cancelled is the sweep having run twice, which is the job
      // being idempotent rather than a failure.
      if (intent.status === 'canceled') return 'CANCELLED';

      throw error;
    }
  }

  parseWebhook(rawBody: Buffer, signature: string): GatewayEvent {
    const event = this.verify(rawBody, signature);

    return {
      eventId: event.id,
      type: event.type,
      // Stored whole, before anything is interpreted (§4.2's inbox).
      payload: event,
      outcome: toOutcome(event),
    };
  }

  /**
   * Verifies against every configured secret before giving up.
   *
   * §10.5 rotates the signing secret with a 24-hour dual-accept window, during
   * which events signed with either the old or the new one are genuine.
   * `constructEvent` checks a single secret, so honouring that window means
   * trying each in turn — newest first, so the steady state costs one attempt.
   */
  private verify(rawBody: Buffer, signature: string): Stripe.Event {
    for (const secret of this.secrets) {
      try {
        return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
      } catch {
        // Try the next secret. The reason is deliberately not inspected: a
        // failure here is either a wrong secret or a forgery, and this loop
        // cannot tell them apart until every secret has been tried.
        continue;
      }
    }

    // Logged, not returned. The response says only that verification failed
    // (see `WebhookSignatureInvalidError`), so a prober learns nothing about
    // how many secrets are configured or which check failed.
    this.logger.warn(
      `Rejected a webhook whose signature matched none of the ${this.secrets.length} configured secret(s).`,
    );
    throw new WebhookSignatureInvalidError();
  }

  async resolveMethod(intentId: string): Promise<PaymentMethod | null> {
    try {
      const intent = await this.stripe.paymentIntents.retrieve(intentId, {
        // The webhook body carries `latest_charge` as a bare id and
        // `payment_method_types` as the list of what was *eligible*, so
        // neither answers which rail the customer picked. Expanding the charge
        // is what does.
        expand: ['latest_charge'],
      });

      const charge = intent.latest_charge;
      // A string here means the expand did not happen, which would be Stripe
      // changing shape underneath us rather than a missing charge.
      if (charge === null || typeof charge === 'string') return null;

      const type = charge.payment_method_details?.type;
      if (type === undefined) return null;

      const method = METHOD_BY_STRIPE_TYPE[type];
      if (method === undefined) {
        this.logger.warn(
          `Payment ${intentId} used "${type}", which this schema has no method for. Recording it without one.`,
        );
        return null;
      }

      return method;
    } catch (error) {
      // Swallowed on purpose. The caller marks the order PAID either way, and
      // a coffee that is not made because a label could not be fetched is a
      // far worse outcome than a payment row missing its method.
      this.logger.warn(
        `Could not resolve the payment method for ${intentId}; recording it without one. ${describeError(error)}`,
      );
      return null;
    }
  }
}

/**
 * Reduces Stripe's event catalog to the four cases the order pipeline acts on.
 *
 * The default is `IGNORED`, and that is the important part: Stripe emits
 * dozens of types and adds more over time, and an unrecognised one is not a
 * failure. It is stored in the inbox and acked, because returning 5xx would
 * have Stripe retry a payload we will never do anything with, forever.
 */
function toOutcome(event: Stripe.Event): GatewayOutcome {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const intent = event.data.object;
      return {
        kind: 'SUCCEEDED',
        intentId: intent.id,
        // `amount_received` rather than `amount`: the first is what Stripe
        // actually took, the second is what we asked for. Reconciliation only
        // means something if it compares against the former.
        amountMinor: intent.amount_received,
        currency: intent.currency.toUpperCase(),
      };
    }
    case 'payment_intent.payment_failed': {
      const intent = event.data.object;
      return {
        kind: 'FAILED',
        intentId: intent.id,
        reason: intent.last_payment_error?.message ?? null,
      };
    }
    case 'payment_intent.canceled':
      return { kind: 'CANCELLED', intentId: event.data.object.id };
    default:
      return { kind: 'IGNORED' };
  }
}
