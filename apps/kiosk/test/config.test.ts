import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config';

const stripe = {
  VITE_STRIPE_PUBLISHABLE_KEY: 'pk_test_example',
  VITE_PROMPTPAY_EMAIL: 'kiosk@cafe.example',
};

describe('readConfig', () => {
  it('needs only the API address in fake mode, and fills in defaults', () => {
    expect(readConfig({ VITE_PAYMENTS: 'fake' })).toEqual({
      apiUrl: 'http://localhost:3000',
      currency: 'THB',
      payments: { mode: 'fake' },
      trackerPollMs: 3000,
      idleMs: 60000,
    });
  });

  it('takes the Stripe publishable key and the PromptPay email in stripe mode', () => {
    expect(readConfig(stripe).payments).toEqual({
      mode: 'stripe',
      publishableKey: 'pk_test_example',
      promptPayEmail: 'kiosk@cafe.example',
    });
  });

  it('defaults to stripe, so a forgotten VITE_PAYMENTS cannot turn on test payments', () => {
    expect(() => readConfig({})).toThrow(/VITE_STRIPE_PUBLISHABLE_KEY/);
  });

  it('refuses a secret key, which must never reach a browser bundle', () => {
    expect(() =>
      readConfig({ ...stripe, VITE_STRIPE_PUBLISHABLE_KEY: 'sk_secret_value' }),
    ).toThrow(/publishable/);
  });

  it.each(['', 'kiosk', 'a@b', 'a b@c.d'])(
    'refuses the PromptPay email %j',
    (email) => {
      expect(() =>
        readConfig({ ...stripe, VITE_PROMPTPAY_EMAIL: email }),
      ).toThrow(/VITE_PROMPTPAY_EMAIL/);
    },
  );

  it('refuses an unknown payments mode', () => {
    expect(() => readConfig({ VITE_PAYMENTS: 'sandbox' })).toThrow(
      /VITE_PAYMENTS/,
    );
  });

  it('trims trailing slashes from the API address', () => {
    expect(
      readConfig({
        VITE_PAYMENTS: 'fake',
        VITE_API_URL: 'https://api.example.com//',
      }).apiUrl,
    ).toBe('https://api.example.com');
  });

  it.each(['0', '-5', '1.5', 'soon'])(
    'refuses %j as a poll interval',
    (value) => {
      expect(() =>
        readConfig({ VITE_PAYMENTS: 'fake', VITE_TRACKER_POLL_MS: value }),
      ).toThrow(/VITE_TRACKER_POLL_MS/);
    },
  );

  it('accepts overrides for the poll interval and the idle timeout', () => {
    const config = readConfig({
      VITE_PAYMENTS: 'fake',
      VITE_TRACKER_POLL_MS: '60000',
      VITE_IDLE_MS: '5000',
    });
    expect([config.trackerPollMs, config.idleMs]).toEqual([60000, 5000]);
  });
});
