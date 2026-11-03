import { loadStripe, type StripeCardElement } from '@stripe/stripe-js';
import { t } from '../i18n';
import type { KioskPayments } from './types';

interface StripeSettings {
  publishableKey: string;
  promptPayEmail: string;
}

const customerMessage = (error: { type: string; message?: string }): string =>
  (error.type === 'card_error' || error.type === 'validation_error') &&
  error.message
    ? error.message
    : t('pay.error.generic');

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const CLIENT_SECRET = /\b(?:pi|seti)_\w+_secret_\w+/g;

// The customer only sees a generic line, so the console is the only place the real cause shows up.
// Whitelisted fields only: a Stripe error can carry the whole PaymentIntent, and a thrown message can quote the client secret.
// Every field is type-checked because this runs inside catch blocks and must not throw.
const report = (step: string, error: unknown): void => {
  const failure = (
    typeof error === 'object' && error !== null ? error : {}
  ) as Record<string, unknown>;
  console.error(`Stripe ${step} failed`, {
    type: text(failure.type) ?? text(failure.name),
    code: text(failure.code),
    declineCode: text(failure.decline_code),
    message: text(failure.message)?.replace(CLIENT_SECRET, '[client secret]'),
  });
};

const explain = (
  step: string,
  reason: string,
  details: Record<string, unknown> = {},
): void => {
  console.error(`Stripe ${step} failed: ${reason}`, details);
};

const qrImageOf = (nextAction: unknown): string | null => {
  const qr = (nextAction as { promptpay_display_qr_code?: unknown } | null)
    ?.promptpay_display_qr_code as { image_url_svg?: unknown } | undefined;
  return typeof qr?.image_url_svg === 'string' ? qr.image_url_svg : null;
};

export const createStripePayments = ({
  publishableKey,
  promptPayEmail,
}: StripeSettings): KioskPayments => {
  const stripe = loadStripe(publishableKey);
  let card: StripeCardElement | null = null;
  const generic = { ok: false as const, message: t('pay.error.generic') };

  return {
    testMode: publishableKey.startsWith('pk_test_'),
    cardField: {
      mount(element) {
        let unmounted = false;
        stripe
          .then((s) => {
            if (!s || unmounted) return;
            card = s.elements().create('card', {
              hidePostalCode: true,
              style: { base: { fontSize: '22px' } },
            });
            card.mount(element);
          })
          .catch((error) => report('card field', error));
        return () => {
          unmounted = true;
          card?.destroy();
          card = null;
        };
      },
    },
    gateway: {
      async payByCard(clientSecret) {
        try {
          const s = await stripe;
          if (!s || !card) {
            explain(
              'card payment',
              s ? 'the card field is not mounted' : 'Stripe.js did not load',
            );
            return generic;
          }
          const result = await s.confirmCardPayment(clientSecret, {
            payment_method: { card },
          });
          if (!result.error) return { ok: true };
          report('card payment', result.error);
          return {
            ok: false,
            message: customerMessage(result.error),
            declined: result.error.type === 'card_error',
          };
        } catch (error) {
          report('card payment', error);
          return generic;
        }
      },
      async startPromptPay(clientSecret) {
        try {
          const s = await stripe;
          if (!s) {
            explain('PromptPay', 'Stripe.js did not load');
            return generic;
          }
          // handleActions: false keeps Stripe from opening its own QR lightbox, which the page cannot close.
          const result = await s.confirmPromptPayPayment(
            clientSecret,
            { payment_method: { billing_details: { email: promptPayEmail } } },
            { handleActions: false },
          );
          if (result.error) {
            report('PromptPay', result.error);
            return { ok: false, message: customerMessage(result.error) };
          }
          const image = qrImageOf(result.paymentIntent?.next_action);
          if (image) return { ok: true, qrImageUrl: image };
          explain('PromptPay', 'the intent has no QR code', {
            status: result.paymentIntent?.status,
            nextAction: result.paymentIntent?.next_action?.type,
          });
          return generic;
        } catch (error) {
          report('PromptPay', error);
          return generic;
        }
      },
    },
  };
};
