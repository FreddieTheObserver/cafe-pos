/** DI token for the shared Stripe client. Inject with `@Inject(STRIPE_CLIENT)`. */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

/**
 * DI token for the webhook signing secrets, newest first (§10.5).
 *
 * Provided as its own token rather than read from `ConfigService` inside the
 * adapter so a test can hand the provider a known secret without standing up
 * a config module around it.
 */
export const STRIPE_WEBHOOK_SECRETS = Symbol('STRIPE_WEBHOOK_SECRETS');
