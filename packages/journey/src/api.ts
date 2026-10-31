import { SEED_PASSWORD, URLS } from './env';

const call = async <T>(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> => {
  const response = await fetch(`${URLS.api}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
};

export const loginAs = async (email: string): Promise<string> =>
  (
    await call<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: { email, password: SEED_PASSWORD },
    })
  ).accessToken;

export const newDevice = (token: string, name: string) =>
  call<{ id: string; pairingCode: string }>('/devices', {
    method: 'POST',
    token,
    body: { name },
  });

export const activateDevice = async (pairingCode: string): Promise<string> =>
  (
    await call<{ deviceToken: string }>('/devices/activate', {
      method: 'POST',
      body: { pairingCode },
    })
  ).deviceToken;

export const revokeDevice = (token: string, id: string) =>
  call<void>(`/devices/${id}/revoke`, { method: 'POST', token });

export interface PaymentAttempt {
  id: string;
  status: string;
  amountMinor: number;
  providerIntentId: string | null;
}

export const paymentsOf = (token: string, orderId: string) =>
  call<PaymentAttempt[]>(`/orders/${orderId}/payments`, { token });
