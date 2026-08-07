import type { PaymentMethod } from '../../database/schema/enums';

/** DI token for the port. The adapter behind it is chosen in `PaymentsModule`. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

/**
 * What the gateway needs to open a payment.
 *
 * Money is minor units and the currency is explicit, because this is the one
 * boundary where a float or an assumed currency stops being a code smell and
 * starts being a customer charged the wrong amount.
 */
export interface CreateIntentRequest {
  amountMinor: number;
  /** ISO 4217, upper-case. `THB` here; the column is `char(3)` (§3.5). */
  currency: string;
  /**
   * The client's key, forwarded so the retry chain is idempotent end to end:
   * kiosk → API → gateway (§5.7). A kiosk that times out and retries must not
   * be able to open a second intent for the same basket.
   */
  idempotencyKey?: string;
  /**
   * Correlation ids the gateway echoes on every webhook. This is how an event
   * arriving out of nowhere is matched back to our rows *without* trusting the
   * client, and the reason the inbox can still identify an event whose intent
   * id we somehow never persisted.
   */
  metadata: Readonly<Record<string, string>>;
}

export interface CreatedIntent {
  /** `payments.provider_intent_id` — the webhook's join key (§7.3). */
  intentId: string;
  /**
   * What the Payment Element needs to confirm, and the one value here that is
   * never written down: it authorises confirming this payment, so it is passed
   * straight through to the client and never persisted or logged (§10.5).
   */
  clientSecret: string;
}

/**
 * The result of asking to cancel — a value, not an exception, because losing
 * the race is *normal*.
 *
 * The expiry job cancels the intent behind an order that aged out (E3). A
 * customer who scans the QR at 9:59 and an expiry sweep that fires at 10:00
 * are both behaving correctly, and the gateway will refuse the cancel because
 * the payment already succeeded. Modelling that as a thrown error would make
 * the sweep log a fault every time a customer paid at the last second — and,
 * worse, invite a caller to treat the order as EXPIRED when the money has
 * actually been taken. Returning it forces the decision to be made.
 */
export type CancelIntentOutcome = 'CANCELLED' | 'ALREADY_SUCCEEDED';

/**
 * A verified, parsed gateway event.
 *
 * `payload` is kept whole and stored before anything is interpreted (§4.2's
 * append-only inbox): it buys dedupe, an audit answer to "what did the gateway
 * actually tell us at 14:02", and replay after a processing bug.
 */
export interface GatewayEvent {
  /** Unique per delivery attempt's *event*, not per delivery — dedupes retries (E4). */
  eventId: string;
  /** The gateway's own type string, stored verbatim for the audit trail. */
  type: string;
  payload: unknown;
  outcome: GatewayOutcome;
}

/**
 * What the event means to the order pipeline, reduced to the four cases this
 * system acts on.
 *
 * Deliberately narrower than the gateway's event catalog. Stripe emits dozens
 * of types and will add more; anything not in this union is `IGNORED`, stored
 * in the inbox, and acked — because an unrecognised event is not a failure,
 * and returning 5xx for one would have the gateway retry it forever.
 */
export type GatewayOutcome =
  | {
      kind: 'SUCCEEDED';
      intentId: string;
      /**
       * What the gateway says it captured. Checked against our own row rather
       * than trusted — they can only disagree if something is wrong, and the
       * one place that must be caught is before an order is marked PAID.
       */
      amountMinor: number;
      currency: string;
    }
  | { kind: 'FAILED'; intentId: string; reason: string | null }
  | { kind: 'CANCELLED'; intentId: string }
  | { kind: 'IGNORED' };

/**
 * The gateway, as the order pipeline sees it (§12.4).
 *
 * The whole point of this interface is that nothing above it imports a Stripe
 * type. Swapping to Omise, 2C2P or GBPrimeGateway is then a new class behind
 * this port rather than an edit to the payment, webhook and expiry paths —
 * which matters more than usual here, because §3.5 already flags that a local
 * Thai PSP may be the only option available to the merchant.
 *
 * There is no `refund`. §12.4 lists one, but refunds are bookkeeping-only in
 * this system: PromptPay refunds require an email address captured at
 * confirmation and the customer replying with the bank account they paid from,
 * and CafePOS holds neither by design (§7.5 minimizes exactly that data). A
 * manager marks the order REFUNDED and staff settle from the till, so no money
 * ever moves back through the gateway and this port needs no verb for it.
 */
export interface PaymentProvider {
  createIntent(request: CreateIntentRequest): Promise<CreatedIntent>;

  /** Cancels an intent that has not been paid. See `CancelIntentOutcome`. */
  cancelIntent(intentId: string): Promise<CancelIntentOutcome>;

  /**
   * Verifies the signature and parses the body, or throws.
   *
   * Takes the **raw** bytes, not a parsed object: the signature covers the
   * exact bytes sent, and any JSON round-trip through a body parser
   * invalidates it.
   *
   * Synchronous, and deliberately so: it touches no network, so the inbox can
   * store an event before anything else can fail (§9.3's store-then-ack). A
   * verification step that could time out would put a network call between
   * "the gateway told us" and "we wrote it down", which is the exact gap the
   * inbox exists to close.
   */
  parseWebhook(rawBody: Buffer, signature: string): GatewayEvent;

  /**
   * What a stored payload means — verification already done, or not needed.
   *
   * The inbox keeps the event, not the conclusion (§4.2), so replaying a row
   * has to re-derive its outcome; by then the bytes the signature covered are
   * gone, and re-verifying is neither possible nor the point. Anything this
   * cannot make sense of is `IGNORED` rather than an error: the inbox is
   * append-only and holds whatever arrived, including events from an API
   * version a later build no longer recognises, and one such row must not stop
   * the sweep that found it.
   *
   * `parseWebhook` is verification plus this. Keeping them one implementation
   * is what stops the wire path and the replay path disagreeing about whether
   * an order was paid.
   */
  interpret(payload: unknown): GatewayOutcome;

  /**
   * Which rail the customer actually chose — **best effort**.
   *
   * Separate from `parseWebhook` because it costs a network round trip that
   * verification must not depend on. With dynamic payment methods the intent
   * in the webhook body does not say which method was used: it carries the
   * *eligible* types and a bare charge id, so the answer needs a second call
   * to the gateway.
   *
   * Null on any of three: the gateway is unreachable, the charge is missing,
   * or it names a rail this system has no enum for. All three resolve the same
   * way on purpose — **the order is marked PAID regardless**. Refusing an
   * event because a label could not be fetched would have the gateway retry it
   * forever while a customer who has already paid waits for a coffee that is
   * not being made. A payment recorded without its method costs the Z-report
   * one row of per-method detail; the alternative costs the customer their
   * order.
   */
  resolveMethod(intentId: string): Promise<PaymentMethod | null>;
}
