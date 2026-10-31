import type { PaymentKeyStore } from '@cafepos/api-client';

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const TOKEN = 'cafepos.kiosk.deviceToken';
const ACTIVE_ORDER = 'cafepos.kiosk.activeOrder';
const PAYMENT_KEYS = 'cafepos.kiosk.paymentKeys';
const KEEP_KEYS = 10;

export const createStores = (storage: KeyValue) => {
  // A tablet that refuses storage still works until it reloads.
  const memory = new Map<string, string>();
  const read = (key: string): string | null => {
    try {
      return storage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  };
  const write = (key: string, value: string) => {
    try {
      storage.setItem(key, value);
    } catch {
      memory.set(key, value);
    }
  };
  const remove = (key: string) => {
    memory.delete(key);
    try {
      storage.removeItem(key);
    } catch {
      // nothing else holds it
    }
  };

  const single = (key: string) => ({
    get: () => read(key),
    set: (value: string) => write(key, value),
    clear: () => remove(key),
  });

  const keys = (): Record<string, string> => {
    try {
      const parsed: unknown = JSON.parse(read(PAYMENT_KEYS) ?? '{}');
      if (typeof parsed !== 'object' || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>;
    } catch {
      return {};
    }
  };

  const paymentKeys: PaymentKeyStore = {
    get: (orderId) => keys()[orderId] ?? null,
    set(orderId, key) {
      const next = { ...keys(), [orderId]: key };
      const newest = Object.entries(next).slice(-KEEP_KEYS);
      write(PAYMENT_KEYS, JSON.stringify(Object.fromEntries(newest)));
    },
    clear(orderId) {
      const { [orderId]: _gone, ...rest } = keys();
      write(PAYMENT_KEYS, JSON.stringify(rest));
    },
  };

  return {
    deviceToken: single(TOKEN),
    activeOrder: single(ACTIVE_ORDER),
    paymentKeys,
  };
};

export type Stores = ReturnType<typeof createStores>;
