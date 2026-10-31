import { describe, expect, it } from 'vitest';
import {
  ApiError,
  NetworkError,
  addLine,
  cartIssues,
  cartTotal,
  createOrderSubmitter,
  createServerClock,
  defaultOptionIds,
  dropUnsellable,
  setQuantity,
  unitPrice,
  type ApiClient,
  type CartLine,
  type Menu,
} from '../src';

const menu = (
  over: {
    latteAvailable?: boolean;
    oatAvailable?: boolean;
    latte?: number;
  } = {},
): Menu => ({
  categories: [
    {
      id: 'c',
      name: 'Coffee',
      sortOrder: 0,
      items: [
        {
          id: 'latte',
          name: 'Latte',
          description: null,
          basePriceMinor: over.latte ?? 6000,
          imageUrl: null,
          isAvailable: over.latteAvailable ?? true,
          sortOrder: 0,
          optionGroups: [
            {
              id: 'milk',
              name: 'Milk',
              minSelect: 1,
              maxSelect: 1,
              sortOrder: 0,
              options: [
                {
                  id: 'dairy',
                  name: 'Dairy',
                  priceDeltaMinor: 0,
                  isDefault: true,
                  isAvailable: true,
                },
                {
                  id: 'oat',
                  name: 'Oat',
                  priceDeltaMinor: 1500,
                  isDefault: false,
                  isAvailable: over.oatAvailable ?? true,
                },
              ],
            },
          ],
        },
        {
          id: 'water',
          name: 'Water',
          description: null,
          basePriceMinor: 1000,
          imageUrl: null,
          isAvailable: true,
          sortOrder: 1,
          optionGroups: [],
        },
      ],
    },
  ],
});

let n = 0;
const key = () => `k${++n}`;
const line = (
  menuItemId: string,
  quantity: number,
  optionIds: string[] = [],
  k = key(),
): CartLine => ({ key: k, menuItemId, quantity, optionIds });

describe('pricing', () => {
  it('adds option deltas to the base price and multiplies by quantity', () => {
    expect(
      cartTotal(menu(), [line('latte', 2, ['oat']), line('water', 1)]),
    ).toBe((6000 + 1500) * 2 + 1000);
  });
  it('never prices a unit below zero', () => {
    const m = menu({ latte: 500 });
    m.categories[0]!.items[0]!.optionGroups[0]!.options[1]!.priceDeltaMinor =
      -9000;
    expect(unitPrice(m.categories[0]!.items[0]!, ['oat'])).toBe(0);
  });
  it('reads the defaults off an item', () => {
    expect(defaultOptionIds(menu().categories[0]!.items[0]!)).toEqual([
      'dairy',
    ]);
  });
});

describe('cartIssues', () => {
  it('is empty for a valid cart', () => {
    expect(cartIssues(menu(), [line('latte', 1, ['dairy'])])).toEqual([]);
  });
  it('flags an item that went sold out, an option that did, and an item that left the menu', () => {
    const a = line('latte', 1, ['dairy'], 'a');
    expect(
      cartIssues(menu({ latteAvailable: false }), [a]).map((i) => i.kind),
    ).toEqual(['item-unavailable']);
    const b = line('latte', 1, ['oat'], 'b');
    expect(
      cartIssues(menu({ oatAvailable: false }), [b]).map((i) => i.kind),
    ).toEqual(['option-unavailable']);
    expect(
      cartIssues(menu(), [line('ghost', 1, [], 'c')]).map((i) => i.kind),
    ).toEqual(['item-gone']);
  });
  it('enforces min and max selection', () => {
    expect(cartIssues(menu(), [line('latte', 1, [], 'a')])).toMatchObject([
      { rule: 'min' },
    ]);
    expect(
      cartIssues(menu(), [line('latte', 1, ['dairy', 'oat'], 'a')]),
    ).toMatchObject([{ rule: 'max' }]);
  });
  it('dropUnsellable keeps only the lines that can still be ordered', () => {
    const keep = line('water', 1, [], 'keep');
    const out = dropUnsellable(menu({ latteAvailable: false }), [
      line('latte', 1, ['dairy'], 'x'),
      keep,
    ]);
    expect(out).toEqual([keep]);
  });
});

describe('cart edits', () => {
  it('merges identical lines and keeps different options apart', () => {
    let l = addLine(
      [],
      { menuItemId: 'latte', quantity: 1, optionIds: ['dairy'] },
      key,
    );
    l = addLine(
      l,
      { menuItemId: 'latte', quantity: 2, optionIds: ['dairy'] },
      key,
    );
    l = addLine(
      l,
      { menuItemId: 'latte', quantity: 1, optionIds: ['oat'] },
      key,
    );
    expect(l.map((x) => x.quantity)).toEqual([3, 1]);
  });
  it('removes a line at quantity 0 and caps at 50', () => {
    const l = [line('water', 1, [], 'w')];
    expect(setQuantity(l, 'w', 0)).toEqual([]);
    expect(setQuantity(l, 'w', 999)[0]?.quantity).toBe(50);
  });
});

describe('createOrderSubmitter', () => {
  const fake = (respond: (body: unknown, key: string) => unknown) => {
    const calls: { body: any; key: string }[] = [];
    const api = {
      orders: {
        create: async (body: unknown, k: string) => {
          calls.push({ body, key: k });
          const r = respond(body, k);
          if (r instanceof Error) throw r;
          return r;
        },
      },
    } as unknown as ApiClient;
    return { api, calls };
  };
  const problem = (
    code: string,
    status: number,
    meta: Record<string, unknown> | null = null,
  ) =>
    new ApiError(
      status,
      {
        type: '',
        title: '',
        status,
        code: code as never,
        detail: 'd',
        requestId: 'r',
        errors: null,
        meta,
      },
      'x',
    );

  it('sends the total the customer saw and the channel', async () => {
    const { api, calls } = fake(() => ({ id: 'o1' }));
    const r = await createOrderSubmitter(api).submit(menu(), [
      line('latte', 1, ['oat']),
    ]);
    expect(r.kind).toBe('placed');
    expect(calls[0]?.body).toMatchObject({
      channel: 'KIOSK',
      expectedTotalMinor: 7500,
    });
  });

  it('reuses the idempotency key when retrying the same basket, and mints a new one when it changes', async () => {
    const { api, calls } = fake(() => new NetworkError('x'));
    const s = createOrderSubmitter(api);
    const basket = [line('water', 1, [], 'a')];
    await s.submit(menu(), basket);
    await s.submit(menu(), basket);
    await s.submit(menu(), [line('water', 2, [], 'a')]);
    expect(calls[0]?.key).toBe(calls[1]?.key);
    expect(calls[2]?.key).not.toBe(calls[0]?.key);
  });

  it('mints a new key when only the price moved', async () => {
    const { api, calls } = fake(() => new NetworkError('x'));
    const s = createOrderSubmitter(api);
    const basket = [line('water', 1, [], 'a')];
    await s.submit(menu(), basket);
    const m = menu();
    m.categories[0]!.items[1]!.basePriceMinor = 1200;
    await s.submit(m, basket);
    expect(calls[1]?.key).not.toBe(calls[0]?.key);
  });

  it('mints a new key when the content changes but the total does not', async () => {
    const { api, calls } = fake(() => new NetworkError('x'));
    const m = menu();
    m.categories[0]!.items[0]!.optionGroups[0]!.options[1]!.priceDeltaMinor = 0; // oat costs the same as dairy
    m.categories[0]!.items[1]!.basePriceMinor = 0; // water is free
    const s = createOrderSubmitter(api);
    await s.submit(m, [line('latte', 1, ['dairy'], 'a')]);
    await s.submit(m, [line('latte', 1, ['oat'], 'a')]);
    await s.submit(m, [line('water', 1, [], 'b')]);
    await s.submit(m, [line('water', 2, [], 'b')]);
    expect(new Set(calls.map((c) => c.key)).size).toBe(4);
  });

  it.each([
    [
      problem('PRICE_MISMATCH', 409, {
        expectedTotalMinor: 1000,
        actualTotalMinor: 1200,
      }),
      { kind: 'price-changed', expected: 1000, actual: 1200 },
    ],
    [problem('ORDER_ITEM_UNAVAILABLE', 409), { kind: 'unavailable' }],
    [problem('OPTION_SELECTION_INVALID', 422), { kind: 'invalid-selection' }],
    [problem('DEVICE_PAUSED', 409), { kind: 'paused' }],
    [problem('DEVICE_REVOKED', 401), { kind: 'revoked' }],
    [problem('RATE_LIMITED', 429), { kind: 'rate-limited' }],
    [new NetworkError('x'), { kind: 'offline' }],
  ])('maps %# to a result the screen can act on', async (err, expected) => {
    const { api } = fake(() => err);
    expect(
      await createOrderSubmitter(api).submit(menu(), [line('water', 1)]),
    ).toMatchObject(expected);
  });
});

describe('createServerClock', () => {
  it('counts down against the server clock, not the tablet clock', () => {
    let tablet = 1_000_000;
    const clock = createServerClock(() => tablet);
    clock.sync(new Date(tablet + 60_000)); // tablet is a minute behind
    const expires = new Date(tablet + 60_000 + 90_000).toISOString();
    expect(clock.secondsUntil(expires)).toBe(90);
    tablet += 30_000;
    expect(clock.secondsUntil(expires)).toBe(60);
  });
  it('floors at zero once expired', () => {
    const clock = createServerClock(() => 5_000);
    expect(clock.secondsUntil(new Date(0).toISOString())).toBe(0);
  });
});
