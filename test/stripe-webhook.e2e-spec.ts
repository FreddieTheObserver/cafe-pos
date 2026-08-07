import { eq, inArray } from 'drizzle-orm';
import Stripe from 'stripe';
import { uuidv7 } from 'uuidv7';
import type { ProblemDetails } from '../src/common/errors/problem-details';
import * as schema from '../src/database/schema';
import { STRIPE_WEBHOOK_SECRETS } from '../src/payments/payments.constants';
import { IdentityHarness } from './fixtures/identity-fixtures';

const ENDPOINT = '/api/v1/webhooks/stripe';

/**
 * `POST /webhooks/stripe` over real HTTP, against a real Postgres.
 *
 * The unit spec proves the controller's branches with a fabricated request
 * object. What only a booted app can answer is the part that object papered
 * over: whether `rawBody` actually survives the body-parser stack. That is a
 * boot-option-and-middleware-ordering question, and getting it wrong fails in
 * the worst possible direction — every genuine Stripe delivery rejected as a
 * forgery, with the logs blaming Stripe.
 */
describe('Stripe webhook endpoint (e2e)', () => {
  let harness: IdentityHarness;
  let secret: string;
  let stripe: Stripe;

  const eventIds: string[] = [];

  const problemOf = (res: { body: unknown }): ProblemDetails =>
    res.body as ProblemDetails;

  /** Signs with the secret the *app* loaded, not one this file invented. */
  const sign = (payload: string, withSecret = secret): string =>
    stripe.webhooks.generateTestHeaderString({ payload, secret: withSecret });

  function eventBody(eventId: string, intentId = 'pi_e2e'): string {
    return JSON.stringify({
      id: eventId,
      object: 'event',
      type: 'payment_intent.succeeded',
      api_version: '2026-07-29.dahlia',
      created: 1_785_829_150,
      data: {
        object: { id: intentId, amount_received: 12_500, currency: 'thb' },
      },
    });
  }

  /** A fresh id per test, so suites can run in any order and clean up only their own. */
  function nextEventId(): string {
    const id = `evt_e2e_${uuidv7()}`;
    eventIds.push(id);
    return id;
  }

  const post = (body: string, signature: string) =>
    harness
      .http()
      .post(ENDPOINT)
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      .send(body);

  const rowsFor = (eventId: string) =>
    harness.db
      .select()
      .from(schema.paymentEvents)
      .where(eq(schema.paymentEvents.providerEventId, eventId));

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    secret = harness.app.get<readonly string[]>(STRIPE_WEBHOOK_SECRETS)[0];
    stripe = new Stripe('sk_test_notarealkey', {
      apiVersion: '2026-07-29.dahlia',
    });
  });

  afterAll(async () => {
    if (eventIds.length > 0) {
      await harness.db
        .delete(schema.paymentEvents)
        .where(inArray(schema.paymentEvents.providerEventId, eventIds));
    }
    await harness.close();
  });

  it('accepts a signed delivery and writes it to the inbox', async () => {
    const eventId = nextEventId();
    const body = eventBody(eventId);

    const response = await post(body, sign(body));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });

    const rows = await rowsFor(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('payment_intent.succeeded');
    // Stored whole and before anything interprets it (§4.2).
    expect(rows[0].payload).toMatchObject({ id: eventId, object: 'event' });
    // Nothing has processed it yet — that is the next slice's job.
    expect(rows[0].processedAt).toBeNull();
  });

  /**
   * E4. Stripe redelivers after any non-2xx *and* after a network failure it
   * cannot attribute, so the same event id arriving twice is routine. A second
   * inbox row would mean replaying the inbox applies one payment twice.
   */
  it('stores a redelivered event only once', async () => {
    const eventId = nextEventId();
    const body = eventBody(eventId);
    const signature = sign(body);

    const first = await post(body, signature);
    const second = await post(body, signature);

    // Both acked: a duplicate is not an error, and answering non-2xx would ask
    // Stripe to keep redelivering an event we already hold.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(await rowsFor(eventId)).toHaveLength(1);
  });

  it('refuses a body signed with the wrong secret', async () => {
    const eventId = nextEventId();
    const body = eventBody(eventId);

    const response = await post(body, sign(body, 'whsec_someoneelses'));

    expect(response.status).toBe(400);
    expect(problemOf(response).code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(await rowsFor(eventId)).toHaveLength(0);
  });

  /**
   * The forgery that matters: a signature lifted from a real delivery, replayed
   * over a body whose amount has been edited. It must fail on the bytes, which
   * is only true if the bytes reaching `constructEvent` are the ones that
   * arrived — the whole point of the `rawBody` wiring.
   */
  it('refuses a body altered after it was signed', async () => {
    const eventId = nextEventId();
    const signed = eventBody(eventId);
    const tampered = signed.replace('12500', '1');

    const response = await post(tampered, sign(signed));

    expect(response.status).toBe(400);
    expect(problemOf(response).code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(await rowsFor(eventId)).toHaveLength(0);
  });

  it('refuses a delivery with no signature header at all', async () => {
    const eventId = nextEventId();
    const body = eventBody(eventId);

    const response = await harness
      .http()
      .post(ENDPOINT)
      .set('content-type', 'application/json')
      .send(body);

    expect(response.status).toBe(400);
    expect(problemOf(response).code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(await rowsFor(eventId)).toHaveLength(0);
  });

  /**
   * The route is `@Public`: Stripe holds no bearer token. This asserts the
   * absence of an Authorization header is *not* what a 400 above was about —
   * an auth guard creeping onto this controller would break every delivery.
   */
  it('needs no bearer token', async () => {
    const eventId = nextEventId();
    const body = eventBody(eventId);

    const response = await post(body, sign(body));

    expect(response.status).not.toBe(401);
    expect(response.status).toBe(200);
  });
});
