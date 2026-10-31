import { ApiError } from './errors';
import type {
  LoginResponse,
  PrincipalDescription,
  TokenResponse,
} from './types';

export interface AuthApi {
  login(email: string, password: string): Promise<LoginResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
  logout(refreshToken: string): Promise<void>;
}

export interface TokenStorage {
  get(): string | null;
  set(refreshToken: string): void;
  clear(): void;
}

/**
 * Holds the access token in memory and the rotating refresh token in storage.
 * Refresh is single-flight: refresh tokens rotate, so two parallel refreshes
 * would present the same token twice and the second would revoke the family.
 */
export const createAuthSession = (auth: AuthApi, storage: TokenStorage) => {
  let accessToken: string | null = null;
  let inflight: Promise<boolean> | null = null;

  const accept = (t: TokenResponse) => {
    accessToken = t.accessToken;
    storage.set(t.refreshToken);
  };
  const drop = () => {
    accessToken = null;
    storage.clear();
  };

  const refresh = (): Promise<boolean> => {
    inflight ??= (async () => {
      const token = storage.get();
      if (!token) return false;
      try {
        accept(await auth.refresh(token));
        return true;
      } catch (error) {
        // Only a definite rejection ends the session; a network blip must not log the cashier out.
        if (error instanceof ApiError && error.status < 500) drop();
        return false;
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    getToken: () => accessToken,
    isSignedIn: () => accessToken !== null,
    refresh,
    async login(
      email: string,
      password: string,
    ): Promise<PrincipalDescription> {
      const res = await auth.login(email, password);
      accept(res);
      return res.user;
    },
    /** True if a stored refresh token produced a working session. */
    restore: refresh,
    async logout(): Promise<void> {
      const token = storage.get();
      drop();
      if (token) await auth.logout(token).catch(() => undefined);
    },
  };
};
