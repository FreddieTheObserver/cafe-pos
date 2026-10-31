import { ApiError, NetworkError } from './errors';
import { newIdempotencyKey, type ApiClient } from './client';
import { cartTotal, type CartLine } from './state/cart';
import type { Menu, OrderView } from './types';

export type PlaceOrderResult =
  | { kind: 'placed'; order: OrderView }
  /** Prices moved since the menu was loaded. Re-fetch the menu, show `actual`, ask again. */
  | { kind: 'price-changed'; expected: number; actual: number | null }
  | { kind: 'unavailable' }
  | { kind: 'invalid-selection' }
  | { kind: 'paused' }
  | { kind: 'revoked' }
  | { kind: 'offline' }
  | { kind: 'rate-limited' }
  | { kind: 'error'; message: string };

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/**
 * One basket → at most one order. The idempotency key is tied to the *content* of the
 * submission: retrying after a dropped connection reuses it (so a first attempt that did
 * land is replayed, not duplicated), while any change to the cart or total mints a new one.
 */
export const createOrderSubmitter = (api: Pick<ApiClient, 'orders'>) => {
  let fingerprint = '';
  let key = '';

  const keyFor = (lines: readonly CartLine[], total: number): string => {
    const fp = JSON.stringify([
      total,
      lines.map((l) => [
        l.menuItemId,
        l.quantity,
        [...l.optionIds].sort(),
        l.notes ?? null,
      ]),
    ]);
    if (fp !== fingerprint) {
      fingerprint = fp;
      key = newIdempotencyKey();
    }
    return key;
  };

  return {
    async submit(
      menu: Menu,
      lines: readonly CartLine[],
    ): Promise<PlaceOrderResult> {
      const expected = cartTotal(menu, lines);
      const idempotencyKey = keyFor(lines, expected);
      try {
        const order = await api.orders.create(
          {
            channel: 'KIOSK',
            expectedTotalMinor: expected,
            items: lines.map((l) => ({
              menuItemId: l.menuItemId,
              quantity: l.quantity,
              optionIds: l.optionIds,
              ...(l.notes ? { notes: l.notes } : {}),
            })),
          },
          idempotencyKey,
        );
        return { kind: 'placed', order };
      } catch (err) {
        if (err instanceof NetworkError) return { kind: 'offline' };
        if (!(err instanceof ApiError))
          return { kind: 'error', message: 'Something went wrong.' };
        switch (err.code) {
          case 'PRICE_MISMATCH':
            return {
              kind: 'price-changed',
              expected,
              actual: num(err.problem?.meta?.actualTotalMinor),
            };
          case 'ORDER_ITEM_UNAVAILABLE':
            return { kind: 'unavailable' };
          case 'OPTION_SELECTION_INVALID':
            return { kind: 'invalid-selection' };
          case 'DEVICE_PAUSED':
            return { kind: 'paused' };
          case 'DEVICE_REVOKED':
            return { kind: 'revoked' };
          case 'RATE_LIMITED':
            return { kind: 'rate-limited' };
          default:
            return err.status === 429
              ? { kind: 'rate-limited' }
              : { kind: 'error', message: err.message };
        }
      }
    },
  };
};
