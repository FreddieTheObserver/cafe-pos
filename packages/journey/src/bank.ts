import Stripe from 'stripe';
import { URLS, WEBHOOK_SECRET } from './env';

const API_VERSION = '2026-08-26.dahlia';
const signer = new Stripe('sk_test_notarealkey', { apiVersion: API_VERSION });
let sequence = 0;

const deliver = async (type: string, object: Record<string, unknown>) => {
  const payload = JSON.stringify({
    id: `evt_journey_${Date.now()}_${sequence++}`,
    object: 'event',
    type,
    api_version: API_VERSION,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  });
  const response = await fetch(`${URLS.api}/api/v1/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signer.webhooks.generateTestHeaderString({
        payload,
        secret: WEBHOOK_SECRET,
      }),
    },
    body: payload,
  });
  if (!response.ok)
    throw new Error(
      `webhook ${type}: ${response.status} ${await response.text()}`,
    );
};

export const settle = (intentId: string, amountMinor: number) =>
  deliver('payment_intent.succeeded', {
    id: intentId,
    amount_received: amountMinor,
    currency: 'thb',
  });

export const decline = (intentId: string) =>
  deliver('payment_intent.payment_failed', {
    id: intentId,
    last_payment_error: null,
  });
