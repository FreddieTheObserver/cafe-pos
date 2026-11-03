import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config';

const key = 'pk_test_abc123abc123abc123';
const stripe = {
  VITE_STRIPE_PUBLISHABLE_KEY: key,
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
      publishableKey: key,
      promptPayEmail: 'kiosk@cafe.example',
    });
  });

  it('accepts a live publishable key', () => {
    const live = 'pk_live_abc123abc123abc123';
    expect(
      readConfig({ ...stripe, VITE_STRIPE_PUBLISHABLE_KEY: live }).payments,
    ).toMatchObject({ publishableKey: live });
  });

  it('defaults to stripe, so a forgotten VITE_PAYMENTS cannot turn on test payments', () => {
    expect(() => readConfig({})).toThrow(/VITE_STRIPE_PUBLISHABLE_KEY/);
  });

  it('refuses a secret key, which must never reach a browser bundle', () => {
    expect(() =>
      readConfig({ ...stripe, VITE_STRIPE_PUBLISHABLE_KEY: 'sk_secret_value' }),
    ).toThrow(/publishable/);
  });

  it.each([
    ['a placeholder copied from a snippet', 'pk_test_...'],
    ['a bare prefix', 'pk_test_'],
    ['an unfilled template', 'pk_test_<your-key>'],
    ['a made-up short word', 'pk_test_example'],
    ['an unknown mode', 'pk_dev_abc123abc123abc123'],
    ['a key with a trailing space', `${key} `],
    ['a key with a line break inside', 'pk_test_abc123abc1\n23abc123'],
  ])('refuses %s', (_name, bad) => {
    expect(() =>
      readConfig({ ...stripe, VITE_STRIPE_PUBLISHABLE_KEY: bad }),
    ).toThrow(/VITE_STRIPE_PUBLISHABLE_KEY/);
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
