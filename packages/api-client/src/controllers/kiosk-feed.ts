import { ApiError, NetworkError } from '../errors';
import type { ApiClient } from '../client';
import type { DeviceStatus, Menu } from '../types';

export interface KioskFeedState {
  menu: Menu | null;
  /** Null until the first status answer. */
  status: DeviceStatus | null;
  /** False while the last request to the server failed to get through. */
  online: boolean;
}

export interface KioskFeedOptions {
  api: Pick<ApiClient, 'menu' | 'auth'>;
  onChange: (state: KioskFeedState) => void;
  menuMs?: number;
  statusMs?: number;
}

/**
 * Polls the menu (conditionally, with its ETag) and the device's own status.
 * A failed poll never clears what the screen already shows: a cafe wifi blip
 * must not blank the menu, only mark the kiosk offline.
 */
export const createKioskFeed = (opts: KioskFeedOptions) => {
  let state: KioskFeedState = { menu: null, status: null, online: true };
  let etag: string | null = null;
  const timers: ReturnType<typeof setInterval>[] = [];
  const busy = { menu: false, status: false };

  const set = (patch: Partial<KioskFeedState>) => {
    state = { ...state, ...patch };
    opts.onChange(state);
  };

  const guard = async (name: 'menu' | 'status', work: () => Promise<void>) => {
    if (busy[name]) return;
    busy[name] = true;
    try {
      await work();
    } catch (err) {
      if (err instanceof NetworkError) set({ online: false });
      else if (err instanceof ApiError && err.code === 'DEVICE_REVOKED')
        set({ status: 'REVOKED', online: true });
      // Any other API error: keep what we have and try again next tick.
    } finally {
      busy[name] = false;
    }
  };

  const pollMenu = () =>
    guard('menu', async () => {
      const r = await opts.api.menu.get(etag);
      if (r.modified) {
        etag = r.etag;
        set({ menu: r.menu, online: true });
      } else {
        set({ online: true });
      }
    });

  const pollStatus = () =>
    guard('status', async () => {
      const me = await opts.api.auth.me();
      set({
        status: me.type === 'device' ? me.status : state.status,
        online: true,
      });
    });

  return {
    start() {
      void pollMenu();
      void pollStatus();
      timers.push(setInterval(() => void pollMenu(), opts.menuMs ?? 10_000));
      timers.push(
        setInterval(() => void pollStatus(), opts.statusMs ?? 15_000),
      );
    },
    stop() {
      for (const t of timers.splice(0)) clearInterval(t);
    },
    pollMenu,
    pollStatus,
  };
};
