import { describe, expect, it } from 'vitest';
import { createStores, type KeyValue } from '../src/stores';

const memoryStorage = (): KeyValue => {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

describe('device token and active order', () => {
  it('round-trips and clears, and survives a reload', () => {
    const storage = memoryStorage();
    createStores(storage).deviceToken.set('token-1');
    expect(createStores(storage).deviceToken.get()).toBe('token-1');
    createStores(storage).deviceToken.clear();
    expect(createStores(storage).deviceToken.get()).toBeNull();
  });

  it('keeps the active order apart from the device token', () => {
    const stores = createStores(memoryStorage());
    stores.deviceToken.set('token-1');
    stores.activeOrder.set('order-1');
    stores.activeOrder.clear();
    expect(stores.deviceToken.get()).toBe('token-1');
    expect(stores.activeOrder.get()).toBeNull();
  });
});

describe('payment keys', () => {
  it('are kept per order and survive a reload, so a reloaded tablet replays its payment', () => {
    const storage = memoryStorage();
    const first = createStores(storage).paymentKeys;
    first.set('o1', 'key-1');
    first.set('o2', 'key-2');
    const reloaded = createStores(storage).paymentKeys;
    expect([
      reloaded.get('o1'),
      reloaded.get('o2'),
      reloaded.get('o3'),
    ]).toEqual(['key-1', 'key-2', null]);
  });

  it('clear one order without touching another', () => {
    const { paymentKeys } = createStores(memoryStorage());
    paymentKeys.set('o1', 'key-1');
    paymentKeys.set('o2', 'key-2');
    paymentKeys.clear('o1');
    expect([paymentKeys.get('o1'), paymentKeys.get('o2')]).toEqual([
      null,
      'key-2',
    ]);
  });

  it('keep only the newest ten, so abandoned orders do not pile up', () => {
    const { paymentKeys } = createStores(memoryStorage());
    for (let i = 1; i <= 12; i++) paymentKeys.set(`o${i}`, `key-${i}`);
    expect([
      paymentKeys.get('o1'),
      paymentKeys.get('o2'),
      paymentKeys.get('o3'),
      paymentKeys.get('o12'),
    ]).toEqual([null, null, 'key-3', 'key-12']);
  });

  it.each(['{not json', '[]', '"text"', 'null', '{"o1":5}'])(
    'read as empty when the stored value is %s',
    (raw) => {
      const storage = memoryStorage();
      storage.setItem('cafepos.kiosk.paymentKeys', raw);
      const { paymentKeys } = createStores(storage);
      expect(paymentKeys.get('o1')).toBeNull();
      paymentKeys.set('o1', 'key-1');
      expect(paymentKeys.get('o1')).toBe('key-1');
    },
  );
});

describe('a tablet whose storage refuses', () => {
  const deny = () => {
    throw new Error('denied');
  };
  const broken: KeyValue = {
    getItem: deny,
    setItem: deny,
    removeItem: deny,
  };

  it('still works until it reloads', () => {
    const stores = createStores(broken);
    stores.deviceToken.set('token-1');
    stores.paymentKeys.set('o1', 'key-1');
    expect(stores.deviceToken.get()).toBe('token-1');
    expect(stores.paymentKeys.get('o1')).toBe('key-1');
    stores.deviceToken.clear();
    expect(stores.deviceToken.get()).toBeNull();
  });
});
