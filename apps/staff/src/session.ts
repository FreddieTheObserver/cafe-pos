import { createApiClient, createAuthSession } from '@cafepos/api-client';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
const KEY = 'cafepos.staff.refresh';

const storage = {
  get: () => sessionStorage.getItem(KEY),
  set: (v: string) => sessionStorage.setItem(KEY, v),
  clear: () => sessionStorage.removeItem(KEY),
};

const bare = createApiClient({ baseUrl: API_URL });
export const session = createAuthSession(bare.auth, storage);
export const api = createApiClient({
  baseUrl: API_URL,
  getToken: session.getToken,
  onUnauthorized: session.refresh,
});
