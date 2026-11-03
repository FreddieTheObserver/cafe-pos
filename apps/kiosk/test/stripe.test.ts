import { loadStripe } from '@stripe/stripe-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../src/i18n';
import { createStripePayments } from '../src/payments/stripe';

vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn() }));

const secret = 'pi_test_secret_test';
const settings = {
  publishableKey: 'pk_test_abc123abc123abc123',
  promptPayEmail: 'kiosk@cafe.example',
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const setup = async (
  stripe: Record<string, unknown>,
  { mountCard = true } = {},
) => {
  const card = { mount: vi.fn(), destroy: vi.fn() };
  vi.mocked(loadStripe).mockResolvedValue({
    elements: () => ({ create: () => card }),
    ...stripe,
  } as never);
  const payments = createStripePayments(settings);
  if (mountCard) payments.cardField.mount({} as HTMLElement);
  await flush();
  return payments;
};

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('payByCard', () => {
  it('shows the card message and logs the decline code', async () => {
    const { gateway } = await setup({
      confirmCardPayment: async () => ({
        error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'Your card has insufficient funds.',
        },
      }),
    });
    expect(await gateway.payByCard(secret)).toEqual({
      ok: false,
      message: 'Your card has insufficient funds.',
      declined: true,
    });
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'card_error',
        code: 'card_declined',
        declineCode: 'insufficient_funds',
      }),
    );
  });

  it('keeps the customer text generic but logs the real code for a non-card error', async () => {
    const { gateway } = await setup({
      confirmCardPayment: async () => ({
        error: {
          type: 'invalid_request_error',
          code: 'payment_intent_unexpected_state',
          message: 'The PaymentIntent is already canceled.',
        },
      }),
    });
    expect(await gateway.payByCard(secret)).toEqual({
      ok: false,
      message: t('pay.error.generic'),
      declined: false,
    });
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'invalid_request_error',
        code: 'payment_intent_unexpected_state',
      }),
    );
  });

  it('logs a thrown error without leaking the client secret', async () => {
    const { gateway } = await setup({
      confirmCardPayment: async () => {
        throw Object.assign(
          new Error(`Invalid intent secret. You specified: ${secret}`),
          { name: 'IntegrationError' },
        );
      },
    });
    expect(await gateway.payByCard(secret)).toEqual({
      ok: false,
      message: t('pay.error.generic'),
    });
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'IntegrationError' }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it('says so when the card field was never mounted', async () => {
    const { gateway } = await setup({}, { mountCard: false });
    expect(await gateway.payByCard(secret)).toEqual({
      ok: false,
      message: t('pay.error.generic'),
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('card field is not mounted'),
      expect.anything(),
    );
  });

  it('still returns the generic text when the thrown value has no usable message', async () => {
    const { gateway } = await setup({
      confirmCardPayment: async () => {
        throw { message: 42 };
      },
    });
    expect(await gateway.payByCard(secret)).toEqual({
      ok: false,
      message: t('pay.error.generic'),
    });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('logs nothing when the payment goes through', async () => {
    const { gateway } = await setup({
      confirmCardPayment: async () => ({
        paymentIntent: { status: 'succeeded' },
      }),
    });
    expect(await gateway.payByCard(secret)).toEqual({ ok: true });
    expect(log).not.toHaveBeenCalled();
  });
});

describe('startPromptPay', () => {
  it('logs the real code when Stripe refuses the PromptPay intent', async () => {
    const { gateway } = await setup({
      confirmPromptPayPayment: async () => ({
        error: {
          type: 'invalid_request_error',
          code: 'payment_method_unactivated',
          message: 'PromptPay is not activated on this account.',
        },
      }),
    });
    expect(await gateway.startPromptPay(secret)).toEqual({
      ok: false,
      message: t('pay.error.generic'),
    });
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'payment_method_unactivated' }),
    );
  });

  it('logs a thrown error and keeps the customer text generic', async () => {
    const { gateway } = await setup({
      confirmPromptPayPayment: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await gateway.startPromptPay(secret)).toEqual({
      ok: false,
      message: t('pay.error.generic'),
    });
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'TypeError',
        message: 'Failed to fetch',
      }),
    );
  });

  it('says what came back when the intent has no QR code', async () => {
    const { gateway } = await setup({
      confirmPromptPayPayment: async () => ({
        paymentIntent: {
          status: 'requires_action',
          next_action: { type: 'redirect_to_url' },
        },
      }),
    });
    expect(await gateway.startPromptPay(secret)).toEqual({
      ok: false,
      message: t('pay.error.generic'),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no QR code'), {
      status: 'requires_action',
      nextAction: 'redirect_to_url',
    });
  });

  it('returns the QR image and logs nothing on success', async () => {
    const { gateway } = await setup({
      confirmPromptPayPayment: async () => ({
        paymentIntent: {
          next_action: {
            promptpay_display_qr_code: { image_url_svg: 'https://qr/x.svg' },
          },
        },
      }),
    });
    expect(await gateway.startPromptPay(secret)).toEqual({
      ok: true,
      qrImageUrl: 'https://qr/x.svg',
    });
    expect(log).not.toHaveBeenCalled();
  });
});

describe('when Stripe.js cannot load', () => {
  it('logs it from the card field and from each payment attempt', async () => {
    vi.mocked(loadStripe).mockRejectedValue(
      Object.assign(new Error('Failed to load Stripe.js'), {
        name: 'LoadError',
      }),
    );
    const { cardField, gateway } = createStripePayments(settings);
    cardField.mount({} as HTMLElement);
    await flush();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('card field'),
      expect.objectContaining({ type: 'LoadError' }),
    );

    expect(await gateway.payByCard(secret)).toEqual({
      ok: false,
      message: t('pay.error.generic'),
    });
    expect(await gateway.startPromptPay(secret)).toEqual({
      ok: false,
      message: t('pay.error.generic'),
    });
    expect(log).toHaveBeenCalledTimes(3);
  });
});
