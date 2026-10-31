import { describe, expect, it } from 'vitest';
import {
  ApiError,
  NetworkError,
  createApiClient,
  createAuthSession,
  type AuthApi,
} from '../src';

const storage = (initial: string | null = 'r0') => {
  let v = initial;
  return {
    get: () => v,
    set: (x: string) => void (v = x),
    clear: () => void (v = null),
  };
};
const tokens = (n: number) => ({
  tokenType: 'Bearer' as const,
  accessToken: `a${n}`,
  refreshToken: `r${n}`,
  expiresIn: 900,
});
const api = (over: Partial<AuthApi> = {}): AuthApi => ({
  login: async () => ({ ...tokens(1), user: {} as never }),
  refresh: async () => tokens(1),
  logout: async () => undefined,
  ...over,
});
const rejected = () => new ApiError(401, null, 'no');

describe('createAuthSession', () => {
  it('shares one refresh between concurrent callers', async () => {
    let calls = 0;
    const s = createAuthSession(
      api({ refresh: async () => (calls++, tokens(calls)) }),
      storage(),
    );
    await Promise.all([s.refresh(), s.refresh(), s.refresh()]);
    expect(calls).toBe(1);
  });

  it('stores the rotated refresh token', async () => {
    const st = storage();
    await createAuthSession(api(), st).refresh();
    expect(st.get()).toBe('r1');
  });

  it('signs out when the refresh token is rejected', async () => {
    const st = storage();
    const s = createAuthSession(
      api({ refresh: async () => Promise.reject(rejected()) }),
      st,
    );
    expect(await s.restore()).toBe(false);
    expect(st.get()).toBeNull();
  });

  it('keeps the session through a network failure', async () => {
    const st = storage();
    const s = createAuthSession(
      api({ refresh: async () => Promise.reject(new NetworkError('x')) }),
      st,
    );
    expect(await s.restore()).toBe(false);
    expect(st.get()).toBe('r0');
  });

  it('logout clears local state even if the server call fails', async () => {
    const st = storage();
    const s = createAuthSession(
      api({ logout: async () => Promise.reject(new Error('x')) }),
      st,
    );
    await s.logout();
    expect(st.get()).toBeNull();
  });
});

describe('createApiClient onUnauthorized', () => {
  it('retries once with the new token after a 401', async () => {
    const seen: (string | undefined)[] = [];
    let token = 'old';
    const fetchStub = (async (_u: string, init: RequestInit) => {
      const h = (init.headers as Record<string, string>).Authorization;
      seen.push(h);
      return h === 'Bearer new'
        ? new Response('[]', { status: 200 })
        : new Response('{}', { status: 401 });
    }) as unknown as typeof fetch;
    const c = createApiClient({
      baseUrl: 'http://x',
      fetch: fetchStub,
      getToken: () => token,
      onUnauthorized: async () => ((token = 'new'), true),
    });
    await c.kds.snapshot();
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
  });

  it('does not loop when the retry is also 401', async () => {
    let n = 0;
    const fetchStub = (async () => (
      n++,
      new Response('{}', { status: 401 })
    )) as unknown as typeof fetch;
    const c = createApiClient({
      baseUrl: 'http://x',
      fetch: fetchStub,
      getToken: () => 't',
      onUnauthorized: async () => true,
    });
    await expect(c.kds.snapshot()).rejects.toBeInstanceOf(ApiError);
    expect(n).toBe(2);
  });
});
