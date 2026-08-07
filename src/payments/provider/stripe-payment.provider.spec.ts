import Stripe from 'stripe';
import { WebhookSignatureInvalidError } from '../errors/payments.errors';
import { StripePaymentProvider } from './stripe-payment.provider';

/**
 * A real Stripe client, never used against the network.
 *
 * `constructEvent` and `generateTestHeaderString` are pure crypto — they hash
 * the body with the secret and compare — so signing a payload here exercises
 * *Stripe's own verification code*, not a mock of it. That matters: this repo
 * has already been bitten by unit fixtures that were invented rather than
 * taken from the real thing, and a hand-rolled HMAC in a test would prove only
 * that the test and the code agree with each other.
 */
const stripe = new Stripe('sk_test_notarealkey', {
  apiVersion: '2026-07-29.dahlia',
});

const NEW_SECRET = 'whsec_newsecret';
const OLD_SECRET = 'whsec_oldsecret';

function sign(payload: string, secret: string): string {
  return stripe.webhooks.generateTestHeaderString({ payload, secret });
}

/** A minimal but structurally real event body. */
function eventBody(
  type: string,
  object: Record<string, unknown>,
  id = 'evt_test_1',
): string {
  return JSON.stringify({
    id,
    object: 'event',
    type,
    api_version: '2026-07-29.dahlia',
    created: 1_785_829_150,
    data: { object },
  });
}

function providerWith(
  secrets: readonly string[],
  client: Stripe = stripe,
): StripePaymentProvider {
  return new StripePaymentProvider(client, secrets);
}

describe('StripePaymentProvider', () => {
  describe('parseWebhook signature verification', () => {
    it('accepts a body signed with the current secret', () => {
      const body = eventBody('payment_intent.canceled', { id: 'pi_1' });
      const provider = providerWith([NEW_SECRET]);

      const event = provider.parseWebhook(
        Buffer.from(body),
        sign(body, NEW_SECRET),
      );

      expect(event.eventId).toBe('evt_test_1');
    });

    /**
     * The reason `STRIPE_WEBHOOK_SECRETS` is a list at all (§10.5). During the
     * 24-hour window after a roll, Stripe is still signing some deliveries
     * with the previous secret. An endpoint that checked only the newest would
     * reject them as forgeries — losing real payments, and looking like an
     * attack in the logs rather than like the config change it is.
     */
    it('accepts a body signed with the previous secret during rotation', () => {
      const body = eventBody('payment_intent.canceled', { id: 'pi_1' });
      const provider = providerWith([NEW_SECRET, OLD_SECRET]);

      const event = provider.parseWebhook(
        Buffer.from(body),
        sign(body, OLD_SECRET),
      );

      expect(event.eventId).toBe('evt_test_1');
    });

    it('rejects a body signed with a secret it does not know', () => {
      const body = eventBody('payment_intent.canceled', { id: 'pi_1' });
      const provider = providerWith([NEW_SECRET, OLD_SECRET]);

      expect(() =>
        provider.parseWebhook(
          Buffer.from(body),
          sign(body, 'whsec_someoneelses'),
        ),
      ).toThrow(WebhookSignatureInvalidError);
    });

    /**
     * The signature covers the bytes, so this is the case that matters most:
     * a valid signature lifted from a real delivery and replayed over an
     * altered body — the "mark my order paid" forgery — must not verify.
     */
    it('rejects a body altered after it was signed', () => {
      const body = eventBody('payment_intent.succeeded', {
        id: 'pi_1',
        amount_received: 17_500,
        currency: 'thb',
      });
      const signature = sign(body, NEW_SECRET);
      const tampered = body.replace('17500', '1');
      const provider = providerWith([NEW_SECRET]);

      expect(() =>
        provider.parseWebhook(Buffer.from(tampered), signature),
      ).toThrow(WebhookSignatureInvalidError);
    });

    it('rejects a signature that is not a signature', () => {
      const body = eventBody('payment_intent.canceled', { id: 'pi_1' });
      const provider = providerWith([NEW_SECRET]);

      expect(() =>
        provider.parseWebhook(Buffer.from(body), 'nonsense'),
      ).toThrow(WebhookSignatureInvalidError);
    });
  });

  describe('parseWebhook outcome mapping', () => {
    const provider = providerWith([NEW_SECRET]);

    function parse(type: string, object: Record<string, unknown>) {
      const body = eventBody(type, object);
      return provider.parseWebhook(Buffer.from(body), sign(body, NEW_SECRET));
    }

    /**
     * `amount_received`, not `amount`. The first is what Stripe actually took;
     * the second is what we asked for. Reconciliation against the gateway is
     * meaningless if it compares our number against our own number.
     */
    it('reads a success as the amount actually received', () => {
      const event = parse('payment_intent.succeeded', {
        id: 'pi_1',
        amount: 99_999,
        amount_received: 17_500,
        currency: 'thb',
      });

      expect(event.outcome).toEqual({
        kind: 'SUCCEEDED',
        intentId: 'pi_1',
        amountMinor: 17_500,
        currency: 'THB',
      });
    });

    it('carries the failure reason through', () => {
      const event = parse('payment_intent.payment_failed', {
        id: 'pi_2',
        last_payment_error: { message: 'Your card was declined.' },
      });

      expect(event.outcome).toEqual({
        kind: 'FAILED',
        intentId: 'pi_2',
        reason: 'Your card was declined.',
      });
    });

    it('tolerates a failure with no reason attached', () => {
      const event = parse('payment_intent.payment_failed', { id: 'pi_3' });

      expect(event.outcome).toEqual({
        kind: 'FAILED',
        intentId: 'pi_3',
        reason: null,
      });
    });

    it('reads a cancellation', () => {
      const event = parse('payment_intent.canceled', { id: 'pi_4' });

      expect(event.outcome).toEqual({ kind: 'CANCELLED', intentId: 'pi_4' });
    });

    /**
     * Stripe emits dozens of types and adds more over time. An unrecognised
     * one is stored and acked, never refused — a 5xx here would have Stripe
     * retry a payload this system will never act on, forever.
     */
    it('ignores a type it does not act on, rather than refusing it', () => {
      const event = parse('charge.updated', { id: 'ch_1' });

      expect(event.outcome).toEqual({ kind: 'IGNORED' });
      expect(event.type).toBe('charge.updated');
    });

    it('keeps the whole payload for the inbox', () => {
      const event = parse('payment_intent.canceled', { id: 'pi_5' });

      expect(event.payload).toMatchObject({
        id: 'evt_test_1',
        type: 'payment_intent.canceled',
      });
    });
  });

  /**
   * Replay (§4.2). The inbox stores the payload, not the outcome, so processing
   * a stored row has to re-derive what the event meant — and there is no
   * signature to check by then, because the bytes it covered are long gone.
   *
   * Split from `parseWebhook` rather than duplicated inside the processor so
   * there is exactly one place that decides what a gateway event means. Two
   * copies of that mapping would drift, and the way they would announce it is
   * an order that the webhook marks PAID and a replay does not.
   */
  describe('interpret', () => {
    const provider = providerWith([NEW_SECRET]);

    it('derives the same outcome from a stored payload as from the wire', () => {
      const body = eventBody('payment_intent.succeeded', {
        id: 'pi_9',
        amount_received: 12_500,
        currency: 'thb',
      });

      const fromWire = provider.parseWebhook(
        Buffer.from(body),
        sign(body, NEW_SECRET),
      );
      // What a jsonb column hands back: parsed, unsigned, structurally equal.
      const fromInbox = provider.interpret(JSON.parse(body));

      expect(fromInbox).toEqual(fromWire.outcome);
    });

    it('needs no signature, because a stored row has none', () => {
      const stored = JSON.parse(
        eventBody('payment_intent.canceled', { id: 'pi_10' }),
      ) as unknown;

      expect(provider.interpret(stored)).toEqual({
        kind: 'CANCELLED',
        intentId: 'pi_10',
      });
    });

    /**
     * A row that cannot be interpreted must not crash the sweep that found it.
     * The inbox is append-only and holds whatever arrived, including events
     * from an API version this build predates.
     */
    it('ignores a payload it cannot make sense of', () => {
      expect(provider.interpret({ nonsense: true })).toEqual({
        kind: 'IGNORED',
      });
      expect(provider.interpret(null)).toEqual({ kind: 'IGNORED' });
    });
  });

  describe('cancelIntent', () => {
    function clientWhere(
      cancel: () => Promise<unknown>,
      retrieveStatus?: string,
    ): Stripe {
      return {
        paymentIntents: {
          cancel,
          retrieve: () => Promise.resolve({ status: retrieveStatus }),
        },
      } as unknown as Stripe;
    }

    function invalidRequest(): Error {
      return new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'You cannot cancel this PaymentIntent.',
      });
    }

    it('reports a clean cancellation', async () => {
      const provider = providerWith(
        [NEW_SECRET],
        clientWhere(() => Promise.resolve({ status: 'canceled' })),
      );

      await expect(provider.cancelIntent('pi_1')).resolves.toBe('CANCELLED');
    });

    /**
     * E3's race, and the reason the outcome is a value rather than an
     * exception. A customer scanning the QR at 9:59 and a sweep firing at
     * 10:00 are both correct; the gateway refuses the cancel because the money
     * is already taken. The sweep has to learn that and leave the order alone
     * for the webhook to mark PAID — not log a fault and expire a paid order.
     */
    it('reports the lost race when the customer paid first', async () => {
      const provider = providerWith(
        [NEW_SECRET],
        clientWhere(() => Promise.reject(invalidRequest()), 'succeeded'),
      );

      await expect(provider.cancelIntent('pi_1')).resolves.toBe(
        'ALREADY_SUCCEEDED',
      );
    });

    /** The sweep running twice is it being idempotent, not failing. */
    it('treats an already-cancelled intent as cancelled', async () => {
      const provider = providerWith(
        [NEW_SECRET],
        clientWhere(() => Promise.reject(invalidRequest()), 'canceled'),
      );

      await expect(provider.cancelIntent('pi_1')).resolves.toBe('CANCELLED');
    });

    /**
     * The status is re-read rather than inferred from the error code, because
     * Stripe raises the same code for every state that forbids a cancel. A
     * state that is neither succeeded nor canceled is a genuine surprise and
     * must not be quietly reported as success.
     */
    it('rethrows when the intent is in some other unexpected state', async () => {
      const provider = providerWith(
        [NEW_SECRET],
        clientWhere(() => Promise.reject(invalidRequest()), 'processing'),
      );

      await expect(provider.cancelIntent('pi_1')).rejects.toThrow(
        /cannot cancel/i,
      );
    });

    it('rethrows a non-request error without re-reading anything', async () => {
      const provider = providerWith(
        [NEW_SECRET],
        clientWhere(() => Promise.reject(new Error('socket hang up'))),
      );

      await expect(provider.cancelIntent('pi_1')).rejects.toThrow(
        'socket hang up',
      );
    });
  });

  describe('resolveMethod', () => {
    function clientReturning(retrieve: () => Promise<unknown>): Stripe {
      return { paymentIntents: { retrieve } } as unknown as Stripe;
    }

    function withCharge(type: string | undefined): Stripe {
      return clientReturning(() =>
        Promise.resolve({
          latest_charge: {
            payment_method_details: type === undefined ? {} : { type },
          },
        }),
      );
    }

    it.each([
      ['card', 'CARD'],
      ['promptpay', 'PROMPTPAY'],
    ])('maps %s to %s', async (stripeType, expected) => {
      const provider = providerWith([NEW_SECRET], withCharge(stripeType));

      await expect(provider.resolveMethod('pi_1')).resolves.toBe(expected);
    });

    /**
     * A manager enabling a new rail in the Dashboard must not be able to break
     * the webhook. The payment is recorded without a method and the order
     * still reaches PAID; the Z-report loses one row of per-method detail.
     */
    it('returns null for a rail this schema has no enum for', async () => {
      const provider = providerWith([NEW_SECRET], withCharge('alipay'));

      await expect(provider.resolveMethod('pi_1')).resolves.toBeNull();
    });

    it('returns null when the charge carries no method details', async () => {
      const provider = providerWith([NEW_SECRET], withCharge(undefined));

      await expect(provider.resolveMethod('pi_1')).resolves.toBeNull();
    });

    it('returns null when there is no charge yet', async () => {
      const provider = providerWith(
        [NEW_SECRET],
        clientReturning(() => Promise.resolve({ latest_charge: null })),
      );

      await expect(provider.resolveMethod('pi_1')).resolves.toBeNull();
    });

    /** An unexpanded id means Stripe changed shape, not that a charge is missing. */
    it('returns null when the expand did not happen', async () => {
      const provider = providerWith(
        [NEW_SECRET],
        clientReturning(() => Promise.resolve({ latest_charge: 'ch_1' })),
      );

      await expect(provider.resolveMethod('pi_1')).resolves.toBeNull();
    });

    /**
     * The whole reason this is a separate call from `parseWebhook`: it can
     * fail, and its failure must not propagate. The order is marked PAID
     * either way.
     */
    it('swallows a gateway failure rather than failing the payment', async () => {
      const provider = providerWith(
        [NEW_SECRET],
        clientReturning(() => Promise.reject(new Error('gateway down'))),
      );

      await expect(provider.resolveMethod('pi_1')).resolves.toBeNull();
    });
  });
});
