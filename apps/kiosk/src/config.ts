export interface KioskConfig {
  apiUrl: string;
  currency: string;
  payments:
    | { mode: 'stripe'; publishableKey: string; promptPayEmail: string }
    | { mode: 'fake' };
  trackerPollMs: number;
  idleMs: number;
}

type Env = Record<string, string | undefined>;

const positiveInt = (env: Env, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive whole number`);
  return value;
};

export const readConfig = (env: Env): KioskConfig => {
  const mode = env.VITE_PAYMENTS ?? 'stripe';
  if (mode !== 'stripe' && mode !== 'fake')
    throw new Error('VITE_PAYMENTS must be "stripe" or "fake"');

  let payments: KioskConfig['payments'] = { mode: 'fake' };
  if (mode === 'stripe') {
    const publishableKey = env.VITE_STRIPE_PUBLISHABLE_KEY ?? '';
    if (!publishableKey.startsWith('pk_'))
      throw new Error(
        'VITE_STRIPE_PUBLISHABLE_KEY must be a publishable key (pk_...), never a secret key',
      );
    const promptPayEmail = env.VITE_PROMPTPAY_EMAIL ?? '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(promptPayEmail))
      throw new Error('VITE_PROMPTPAY_EMAIL must be an email address');
    payments = { mode, publishableKey, promptPayEmail };
  }

  return {
    apiUrl: (env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    currency: env.VITE_CURRENCY ?? 'THB',
    payments,
    trackerPollMs: positiveInt(env, 'VITE_TRACKER_POLL_MS', 3_000),
    idleMs: positiveInt(env, 'VITE_IDLE_MS', 60_000),
  };
};
