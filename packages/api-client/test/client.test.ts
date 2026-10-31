import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError, createApiClient } from '../src';

type Call = { url: string; init: RequestInit };

const stub = (respond: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetchStub };
};

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

const problem = (code: string, status: number) => ({
  type: 'x',
  title: 't',
  status,
  code,
  detail: `detail for ${code}`,
  requestId: 'req-1',
  errors: null,
  meta: null,
});

describe('createApiClient', () => {
  it('sends the bearer token and prefixes /api/v1', async () => {
    const { calls, fetchStub } = stub(() => json([]));
    const api = createApiClient({
      baseUrl: 'http://x/',
      getToken: () => 'tok',
      fetch: fetchStub,
    });
    await api.kds.snapshot();
    expect(calls[0]?.url).toBe('http://x/api/v1/kds/orders');
    expect(
      (calls[0]?.init.headers as Record<string, string>).Authorization,
    ).toBe('Bearer tok');
  });

  it('sends no credential to public routes', async () => {
    const { calls, fetchStub } = stub(() => json([]));
    const api = createApiClient({
      baseUrl: 'http://x',
      getToken: () => 'tok',
      fetch: fetchStub,
    });
    await api.orders.board();
    expect(
      (calls[0]?.init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it('turns a problem body into an ApiError carrying the code', async () => {
    const { fetchStub } = stub(() =>
      json(problem('PRICE_MISMATCH', 409), { status: 409 }),
    );
    const api = createApiClient({ baseUrl: 'http://x', fetch: fetchStub });
    const error = await api.orders
      .create(
        {
          channel: 'KIOSK',
          items: [{ menuItemId: 'i', quantity: 1, optionIds: [] }],
        },
        'key-12345',
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PRICE_MISMATCH');
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).requestId).toBe('req-1');
  });

  it('still throws an ApiError when the body is not a problem document', async () => {
    const { fetchStub } = stub(
      () => new Response('<html>bad gateway</html>', { status: 502 }),
    );
    const api = createApiClient({ baseUrl: 'http://x', fetch: fetchStub });
    const error = await api.menu.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBeNull();
    expect((error as ApiError).status).toBe(502);
  });

  it('wraps a failed fetch as NetworkError, not ApiError', async () => {
    const { fetchStub } = stub(() => {
      throw new TypeError('Failed to fetch');
    });
    const api = createApiClient({ baseUrl: 'http://x', fetch: fetchStub });
    await expect(api.menu.get()).rejects.toBeInstanceOf(NetworkError);
  });

  it('sends the Idempotency-Key header on order creation', async () => {
    const { calls, fetchStub } = stub(() => json({}, { status: 201 }));
    const api = createApiClient({ baseUrl: 'http://x', fetch: fetchStub });
    await api.orders.create({ channel: 'KIOSK', items: [] }, 'key-12345');
    expect(
      (calls[0]?.init.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe('key-12345');
  });

  describe('menu.get', () => {
    it('returns the ETag with a fresh menu and sends it back as If-None-Match', async () => {
      const { calls, fetchStub } = stub(({ init }) =>
        (init.headers as Record<string, string>)['If-None-Match'] === '"v1"'
          ? new Response(null, { status: 304 })
          : json(
              { categories: [] },
              { headers: { ETag: '"v1"', 'Content-Type': 'application/json' } },
            ),
      );
      const api = createApiClient({ baseUrl: 'http://x', fetch: fetchStub });

      const first = await api.menu.get();
      expect(first).toMatchObject({ modified: true, etag: '"v1"' });

      const second = await api.menu.get('"v1"');
      expect(second).toEqual({ modified: false });
      expect(
        (calls[1]?.init.headers as Record<string, string>)['If-None-Match'],
      ).toBe('"v1"');
    });
  });
});
