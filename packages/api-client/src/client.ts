import { ApiError, NetworkError, isProblem } from './errors';
import type {
  ActivatedDevice,
  CreateOrderDto,
  CreatePaymentDto,
  KdsTicket,
  LoginResponse,
  Menu,
  MenuItem,
  OrderDetail,
  OrderSummary,
  OrderView,
  PaymentView,
  PrincipalDescription,
  BoardEntry,
  TokenResponse,
  OrderStatus,
} from './types';

export interface ApiClientOptions {
  /** API origin, e.g. `https://api.example.com`. The `/api/v1` prefix is added here. */
  baseUrl: string;
  /** Called per request, so a refreshed token is picked up without rebuilding the client. */
  getToken?: () => string | null | Promise<string | null>;
  fetch?: typeof fetch;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  auth?: boolean;
  signal?: AbortSignal;
}

export type MenuResult =
  { modified: true; menu: Menu; etag: string | null } | { modified: false };

export const newIdempotencyKey = (): string => crypto.randomUUID();

export const createApiClient = (options: ApiClientOptions) => {
  const doFetch =
    options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const root = `${options.baseUrl.replace(/\/+$/, '')}/api/v1`;

  const send = async (
    path: string,
    opts: RequestOptions,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...opts.headers,
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.auth !== false && options.getToken) {
      const token = await options.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await doFetch(`${root}${path}`, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
      });
    } catch (error) {
      throw new NetworkError(error);
    }
    return response;
  };

  const failure = async (response: Response): Promise<ApiError> => {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // A proxy error page or an empty body: fall through to the status text.
    }
    return new ApiError(
      response.status,
      isProblem(parsed) ? parsed : null,
      response.statusText || `HTTP ${response.status}`,
    );
  };

  const request = async <T>(
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> => {
    const response = await send(path, opts);
    if (!response.ok) throw await failure(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };

  const enc = encodeURIComponent;

  return {
    auth: {
      login: (email: string, password: string) =>
        request<LoginResponse>('/auth/login', {
          method: 'POST',
          body: { email, password },
          auth: false,
        }),
      refresh: (refreshToken: string) =>
        request<TokenResponse>('/auth/refresh', {
          method: 'POST',
          body: { refreshToken },
          auth: false,
        }),
      /** Describes the caller; for a kiosk this is also the device status poll. */
      me: (signal?: AbortSignal) =>
        request<PrincipalDescription>('/auth/me', { signal }),
      logout: (refreshToken: string) =>
        request<void>('/auth/logout', {
          method: 'POST',
          body: { refreshToken },
        }),
    },
    devices: {
      activate: (pairingCode: string) =>
        request<ActivatedDevice>('/devices/activate', {
          method: 'POST',
          body: { pairingCode },
          auth: false,
        }),
    },
    menu: {
      /** Conditional GET. `{ modified: false }` on 304, so the caller keeps what it has. */
      get: async (
        etag?: string | null,
        signal?: AbortSignal,
      ): Promise<MenuResult> => {
        const response = await send('/menu', {
          headers: etag ? { 'If-None-Match': etag } : undefined,
          signal,
        });
        if (response.status === 304) return { modified: false };
        if (!response.ok) throw await failure(response);
        return {
          modified: true,
          menu: (await response.json()) as Menu,
          etag: response.headers.get('ETag'),
        };
      },
    },
    items: {
      list: () => request<MenuItem[]>('/items'),
      setAvailability: (id: string, isAvailable: boolean) =>
        request<MenuItem>(`/items/${enc(id)}/availability`, {
          method: 'PATCH',
          body: { isAvailable },
        }),
    },
    orders: {
      create: (body: CreateOrderDto, idempotencyKey: string) =>
        request<OrderView>('/orders', { method: 'POST', body, idempotencyKey }),
      get: (id: string, signal?: AbortSignal) =>
        request<OrderDetail>(`/orders/${enc(id)}`, { signal }),
      cancel: (id: string) =>
        request<OrderSummary>(`/orders/${enc(id)}/cancel`, {
          method: 'POST',
          body: {},
        }),
      transition: (id: string, toStatus: OrderStatus) =>
        request<OrderSummary>(`/orders/${enc(id)}/status`, {
          method: 'POST',
          body: { to: toStatus },
        }),
      /** Public: the board needs no credential. */
      board: (signal?: AbortSignal) =>
        request<BoardEntry[]>('/orders/board', { auth: false, signal }),
      createPayment: (
        id: string,
        body: CreatePaymentDto,
        idempotencyKey: string,
      ) =>
        request<PaymentView>(`/orders/${enc(id)}/payments`, {
          method: 'POST',
          body,
          idempotencyKey,
        }),
    },
    kds: {
      snapshot: (signal?: AbortSignal) =>
        request<KdsTicket[]>('/kds/orders', { signal }),
    },
  };
};

export type ApiClient = ReturnType<typeof createApiClient>;
