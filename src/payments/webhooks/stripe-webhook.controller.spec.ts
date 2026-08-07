import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import Stripe from 'stripe';
import { WebhookSignatureInvalidError } from '../errors/payments.errors';
import type { GatewayEvent } from '../provider/payment-provider';
import { StripePaymentProvider } from '../provider/stripe-payment.provider';
import type { PaymentEventProcessor } from './payment-event-processor.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import type { WebhookInboxService } from './webhook-inbox.service';

/**
 * The same real-client trick the provider spec uses: `generateTestHeaderString`
 * and `constructEvent` are pure crypto, so signing here exercises Stripe's own
 * verification rather than a mock of it. The controller gets the real provider
 * for the same reason — the signature check is the authentication on this
 * route, and a stubbed one would prove nothing about it.
 */
const stripe = new Stripe('sk_test_notarealkey', {
  apiVersion: '2026-07-29.dahlia',
});

const SECRET = 'whsec_thetestsecret';

function eventBody(id = 'evt_test_1'): string {
  return JSON.stringify({
    id,
    object: 'event',
    type: 'payment_intent.succeeded',
    api_version: '2026-07-29.dahlia',
    created: 1_785_829_150,
    data: {
      object: {
        id: 'pi_1',
        amount_received: 12_500,
        currency: 'thb',
      },
    },
  });
}

function sign(payload: string): string {
  return stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
}

/**
 * Records what reached the inbox without pretending to be one.
 *
 * Deliberately has no dedupe logic: whether a repeated event id writes a second
 * row is a property of a UNIQUE index in Postgres, so asserting it here would
 * only prove this class agrees with itself. That belongs in the e2e suite, and
 * lives there.
 */
class RecordingInbox {
  readonly recorded: GatewayEvent[] = [];

  /** `null` reproduces the redelivery case: the unique index turned it away. */
  constructor(private readonly rowId: string | null = 'evt_row_1') {}

  record(event: GatewayEvent): Promise<{ eventRowId: string | null }> {
    this.recorded.push(event);
    return Promise.resolve({ eventRowId: this.rowId });
  }
}

/** Records which rows the controller asked to have processed. */
class RecordingProcessor {
  readonly kicked: string[] = [];

  processEvent(eventId: string): Promise<boolean> {
    this.kicked.push(eventId);
    return Promise.resolve(true);
  }
}

function controllerWith(
  inbox: RecordingInbox,
  processor: RecordingProcessor = new RecordingProcessor(),
): StripeWebhookController {
  return new StripeWebhookController(
    new StripePaymentProvider(stripe, [SECRET]),
    inbox as unknown as WebhookInboxService,
    processor as unknown as PaymentEventProcessor,
  );
}

/** A request as Nest hands it over once `rawBody: true` is set at boot. */
function requestWith(rawBody: Buffer | undefined): RawBodyRequest<Request> {
  return { rawBody } as RawBodyRequest<Request>;
}

describe('StripeWebhookController', () => {
  it('stores a correctly signed event and acks it', async () => {
    const body = eventBody();
    const inbox = new RecordingInbox();

    const response = await controllerWith(inbox).receive(
      requestWith(Buffer.from(body)),
      sign(body),
    );

    expect(response).toEqual({ received: true });
    expect(inbox.recorded).toHaveLength(1);
    expect(inbox.recorded[0].eventId).toBe('evt_test_1');
    expect(inbox.recorded[0].outcome).toEqual({
      kind: 'SUCCEEDED',
      intentId: 'pi_1',
      amountMinor: 12_500,
      currency: 'THB',
    });
  });

  it('kicks processing for the row it just stored', async () => {
    const body = eventBody();
    const processor = new RecordingProcessor();

    await controllerWith(new RecordingInbox('evt_row_7'), processor).receive(
      requestWith(Buffer.from(body)),
      sign(body),
    );

    expect(processor.kicked).toEqual(['evt_row_7']);
  });

  /**
   * A redelivery the unique index turned away has no new row, and the original
   * is already someone else's work. Kicking anyway would put two workers on one
   * row for no gain — the guarded `processed_at IS NULL` would settle it, but
   * racing on purpose is not a design.
   */
  it('does not kick processing for a redelivery it did not store', async () => {
    const body = eventBody();
    const processor = new RecordingProcessor();

    const response = await controllerWith(
      new RecordingInbox(null),
      processor,
    ).receive(requestWith(Buffer.from(body)), sign(body));

    // Still acked: a duplicate is not an error.
    expect(response).toEqual({ received: true });
    expect(processor.kicked).toEqual([]);
  });

  /**
   * The forgery case. A body that fails verification must not reach the inbox
   * at all — storing it first would let anyone who can reach this endpoint
   * write rows into the audit trail the inbox exists to be.
   */
  it('refuses a forged body without storing anything', async () => {
    const inbox = new RecordingInbox();
    const forged = eventBody('evt_forged');

    await expect(
      controllerWith(inbox).receive(
        requestWith(Buffer.from(forged)),
        stripe.webhooks.generateTestHeaderString({
          payload: forged,
          secret: 'whsec_someoneelses',
        }),
      ),
    ).rejects.toThrow(WebhookSignatureInvalidError);

    expect(inbox.recorded).toHaveLength(0);
  });

  /**
   * No header at all is the same answer as a wrong one, and for the same
   * reason: §10.1 makes the signature the authentication, and a caller learns
   * nothing from the response about which check it failed.
   */
  it('refuses a body with no signature header', async () => {
    const inbox = new RecordingInbox();
    const body = eventBody();

    await expect(
      controllerWith(inbox).receive(requestWith(Buffer.from(body)), undefined),
    ).rejects.toThrow(WebhookSignatureInvalidError);

    expect(inbox.recorded).toHaveLength(0);
  });

  /**
   * `rawBody` missing means the app was booted without `rawBody: true` — the
   * one wiring mistake that would otherwise fail *open*, because every body
   * would then be unverifiable and this route would reject genuine events as
   * forgeries. A 500 names it as our bug rather than blaming the caller.
   */
  it('fails loudly when the raw body was never captured', async () => {
    const inbox = new RecordingInbox();
    const body = eventBody();

    await expect(
      controllerWith(inbox).receive(requestWith(undefined), sign(body)),
    ).rejects.toThrow(/raw body/i);

    expect(inbox.recorded).toHaveLength(0);
  });
});
