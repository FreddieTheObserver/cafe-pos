import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env.validation';
import { STRIPE_CLIENT, STRIPE_WEBHOOK_SECRETS } from './payments.constants';
import { PAYMENT_PROVIDER } from './provider/payment-provider';
import { StripePaymentProvider } from './provider/stripe-payment.provider';
import { CreatePaymentController } from './create/create-payment.controller';
import { CreatePaymentService } from './create/create-payment.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { CreateRefundController } from './refunds/create-refund.controller';
import { CreateRefundService } from './refunds/create-refund.service';
import { OrderPaymentsController } from './query/order-payments.controller';
import { OrderPaymentsService } from './query/order-payments.service';
import { PaymentEventProcessor } from './webhooks/payment-event-processor.service';
import { StripeWebhookController } from './webhooks/stripe-webhook.controller';
import { WebhookInboxService } from './webhooks/webhook-inbox.service';

/**
 * Splits a base URL into the three pieces the Stripe client wants separately.
 *
 * The SDK takes `host`, `port` and `protocol` rather than a URL, so this is the
 * adapter between a single readable env var and that shape.
 */
function apiBase(
  base: string | undefined,
): Pick<Stripe.StripeConfig, 'host' | 'port' | 'protocol'> {
  if (base === undefined) return {};

  const url = new URL(base);
  return {
    host: url.hostname,
    /**
     * Omitted rather than coerced when the URL carries no explicit port.
     * `new URL('https://gateway.internal').port` is the empty string, and
     * `Number('')` is 0 — a port the client would try to use and fail on,
     * instead of falling back to the scheme's default.
     */
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    protocol: url.protocol === 'https:' ? 'https' : 'http',
  };
}

/**
 * Payments (§17 phase 4).
 *
 * Not `@Global`, unlike the database, Redis and storage modules: those are
 * infrastructure half the app reaches for, while the gateway is spoken to from
 * exactly two places — the payment routes and the expiry sweep. Keeping it a
 * normal module means an import is a visible statement that a module moves
 * money.
 */
@Module({
  controllers: [
    StripeWebhookController,
    CreatePaymentController,
    OrderPaymentsController,
    CreateRefundController,
  ],
  providers: [
    WebhookInboxService,
    PaymentEventProcessor,
    CreatePaymentService,
    OrderPaymentsService,
    CreateRefundService,
    ReconciliationService,
    {
      provide: STRIPE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Stripe(config.get('STRIPE_SECRET_KEY', { infer: true }), {
          /**
           * Empty unless `STRIPE_API_BASE` is set, which only CI does — see the
           * env contract. Spread first so a mistyped base cannot silently
           * override the settings below it.
           */
          ...apiBase(config.get('STRIPE_API_BASE', { infer: true })),
          /**
           * Pinned, not left to drift. An unpinned client follows whatever
           * version the account is set to, so a Dashboard change — or Stripe
           * defaulting a new account differently — could alter response shapes
           * under a deployed build. This value matches the version the
           * installed SDK's types were generated from, so a bump is an
           * intentional edit that typechecks.
           */
          apiVersion: '2026-07-29.dahlia',
          /**
           * §9.3: 10-second timeout, one retry, network-class errors only.
           * Safe to retry because every mutating call here carries an
           * idempotency key — Stripe's own, on create — so a retry after a
           * timeout reaches the same intent rather than opening a second one.
           */
          timeout: 10_000,
          maxNetworkRetries: 1,
        }),
    },
    {
      provide: STRIPE_WEBHOOK_SECRETS,
      inject: [ConfigService],
      /**
       * `getOrThrow<string[]>` rather than the `{ infer: true }` form used
       * everywhere else in this file.
       *
       * `infer` resolves a key through `PathValue`, which walks into the
       * property's type to build dotted paths. That works for the scalar
       * settings but degrades to `any` on an array-valued key — so the
       * inferred read of this one would hand the provider an unchecked value
       * while looking exactly like the typed reads above it. Naming the type
       * on the non-infer overload gets the checking back.
       *
       * `getOrThrow` because `validateEnv` has already guaranteed the key is
       * present: if it somehow is not, that is a broken boot, not a `readonly
       * string[]` that happens to be undefined.
       */
      useFactory: (config: ConfigService<Env, true>): readonly string[] =>
        config.getOrThrow<string[]>('STRIPE_WEBHOOK_SECRETS'),
    },
    { provide: PAYMENT_PROVIDER, useClass: StripePaymentProvider },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
