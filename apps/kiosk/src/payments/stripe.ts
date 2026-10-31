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
        void stripe.then((s) => {
          if (!s || unmounted) return;
          card = s.elements().create('card', {
            hidePostalCode: true,
            style: { base: { fontSize: '22px' } },
          });
          card.mount(element);
        });
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
          if (!s || !card) return generic;
          const result = await s.confirmCardPayment(clientSecret, {
            payment_method: { card },
          });
          return result.error
            ? {
                ok: false,
                message: customerMessage(result.error),
                declined: result.error.type === 'card_error',
              }
            : { ok: true };
        } catch {
          return generic;
        }
      },
      async startPromptPay(clientSecret) {
        try {
          const s = await stripe;
          if (!s) return generic;
          // handleActions: false keeps Stripe from opening its own QR lightbox, which the page cannot close.
          const result = await s.confirmPromptPayPayment(
            clientSecret,
            { payment_method: { billing_details: { email: promptPayEmail } } },
            { handleActions: false },
          );
          if (result.error)
            return { ok: false, message: customerMessage(result.error) };
          const image = qrImageOf(result.paymentIntent?.next_action);
          return image ? { ok: true, qrImageUrl: image } : generic;
        } catch {
          return generic;
        }
      },
    },
  };
};
