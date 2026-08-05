import {
  OptionSelectionInvalidError,
  OrderItemUnavailableError,
} from '../errors/orders.errors';
import {
  priceOrder,
  type CatalogItem,
  type RequestedItem,
} from './order-pricing';

/** 7% VAT-inclusive (§3.3), expressed the way the config carries it. */
const VAT_BASIS_POINTS = 700;

const SIZE_GROUP = {
  id: 'g-size',
  name: 'Size',
  minSelect: 1,
  maxSelect: 1,
  options: [
    { id: 'o-small', name: 'Small', priceDeltaMinor: -1000, isAvailable: true },
    { id: 'o-regular', name: 'Regular', priceDeltaMinor: 0, isAvailable: true },
    { id: 'o-large', name: 'Large', priceDeltaMinor: 2000, isAvailable: true },
  ],
};

const MILK_GROUP = {
  id: 'g-milk',
  name: 'Milk',
  minSelect: 0,
  maxSelect: 1,
  options: [
    { id: 'o-oat', name: 'Oat milk', priceDeltaMinor: 1500, isAvailable: true },
    { id: 'o-none', name: 'No milk', priceDeltaMinor: 0, isAvailable: false },
  ],
};

const EXTRAS_GROUP = {
  id: 'g-extras',
  name: 'Extras',
  minSelect: 0,
  maxSelect: 5,
  options: [
    {
      id: 'o-shot',
      name: 'Extra shot',
      priceDeltaMinor: 500,
      isAvailable: true,
    },
    {
      id: 'o-syrup',
      name: 'Vanilla syrup',
      priceDeltaMinor: 500,
      isAvailable: true,
    },
  ],
};

/** Mirrors the seeded menu: a drink with groups, a pastry with none. */
function buildCatalog(
  overrides: Partial<CatalogItem>[] = [],
): Map<string, CatalogItem> {
  const items: CatalogItem[] = [
    {
      id: 'i-latte',
      name: 'Iced Latte',
      basePriceMinor: 9500,
      isAvailable: true,
      optionGroups: [SIZE_GROUP, MILK_GROUP, EXTRAS_GROUP],
    },
    {
      id: 'i-croissant',
      name: 'Butter croissant',
      basePriceMinor: 2000,
      isAvailable: true,
      optionGroups: [],
    },
  ];

  const catalog = new Map(items.map((item) => [item.id, item]));
  for (const override of overrides) {
    const existing = catalog.get(override.id as string);
    if (existing) catalog.set(existing.id, { ...existing, ...override });
  }
  return catalog;
}

function line(overrides: Partial<RequestedItem> = {}): RequestedItem {
  return {
    menuItemId: 'i-croissant',
    quantity: 1,
    optionIds: [],
    notes: null,
    ...overrides,
  };
}

const price = (
  requested: RequestedItem[],
  catalog: Map<string, CatalogItem> = buildCatalog(),
) => priceOrder(requested, catalog, VAT_BASIS_POINTS);

describe('priceOrder', () => {
  describe('money', () => {
    it('prices an item with no options from its base price', () => {
      const result = price([line()]);

      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toMatchObject({
        menuItemId: 'i-croissant',
        nameSnapshot: 'Butter croissant',
        unitPriceMinorSnapshot: 2000,
        quantity: 1,
        lineTotalMinor: 2000,
      });
      expect(result.subtotalMinor).toBe(2000);
      expect(result.totalMinor).toBe(2000);
    });

    it('adds each selected option delta to the unit price', () => {
      const result = price([
        line({
          menuItemId: 'i-latte',
          optionIds: ['o-large', 'o-oat', 'o-shot'],
        }),
      ]);

      // 9500 + 2000 + 1500 + 500
      expect(result.lines[0].unitPriceMinorSnapshot).toBe(13500);
      expect(result.lines[0].lineTotalMinor).toBe(13500);
    });

    it('multiplies the option-inclusive unit price by quantity', () => {
      const result = price([
        line({ menuItemId: 'i-latte', quantity: 3, optionIds: ['o-large'] }),
      ]);

      expect(result.lines[0].unitPriceMinorSnapshot).toBe(11500);
      expect(result.lines[0].lineTotalMinor).toBe(34500);
    });

    it('lets a negative delta reduce the price', () => {
      const result = price([
        line({ menuItemId: 'i-latte', optionIds: ['o-small'] }),
      ]);

      expect(result.lines[0].unitPriceMinorSnapshot).toBe(8500);
    });

    /**
     * The obligation Phase 2 handed over: `price_delta_minor` carries no CHECK,
     * so a menu can be configured into a negative line. Only pricing sees the
     * whole basket, so only pricing can hold the floor.
     */
    it('clamps a unit price the deltas drove below zero', () => {
      const catalog = buildCatalog([{ id: 'i-latte', basePriceMinor: 500 }]);

      const result = price(
        [line({ menuItemId: 'i-latte', quantity: 2, optionIds: ['o-small'] })],
        catalog,
      );

      // 500 - 1000 = -500, floored rather than credited back to the customer.
      expect(result.lines[0].unitPriceMinorSnapshot).toBe(0);
      expect(result.lines[0].lineTotalMinor).toBe(0);
      expect(result.totalMinor).toBe(0);
    });

    it('sums every line into the subtotal and total', () => {
      const result = price([
        line({
          menuItemId: 'i-latte',
          optionIds: ['o-large', 'o-oat', 'o-shot'],
        }),
        line({ menuItemId: 'i-croissant', quantity: 2 }),
      ]);

      expect(result.subtotalMinor).toBe(17500);
      expect(result.totalMinor).toBe(17500);
    });

    /** The §5.3 worked example, kept as the arithmetic's fixed point. */
    it('extracts VAT from the total rather than adding it', () => {
      const result = price([
        line({
          menuItemId: 'i-latte',
          optionIds: ['o-large', 'o-oat', 'o-shot'],
        }),
        line({ menuItemId: 'i-croissant', quantity: 2 }),
      ]);

      // round(17500 * 7 / 107)
      expect(result.vatMinor).toBe(1145);
      expect(result.totalMinor).toBe(17500);
    });

    it('reports no VAT on a free order', () => {
      const catalog = buildCatalog([{ id: 'i-croissant', basePriceMinor: 0 }]);

      expect(price([line()], catalog).vatMinor).toBe(0);
    });

    it('preserves the submitted line order', () => {
      const result = price([
        line({ menuItemId: 'i-croissant' }),
        line({ menuItemId: 'i-latte', optionIds: ['o-regular'] }),
      ]);

      expect(result.lines.map((l) => l.menuItemId)).toEqual([
        'i-croissant',
        'i-latte',
      ]);
    });
  });

  describe('snapshots', () => {
    it('captures the name and price the customer is agreeing to', () => {
      const result = price([
        line({ menuItemId: 'i-latte', optionIds: ['o-large', 'o-oat'] }),
      ]);

      expect(result.lines[0].nameSnapshot).toBe('Iced Latte');
      expect(result.lines[0].options).toEqual([
        {
          optionId: 'o-large',
          groupNameSnapshot: 'Size',
          optionNameSnapshot: 'Large',
          priceDeltaMinorSnapshot: 2000,
        },
        {
          optionId: 'o-oat',
          groupNameSnapshot: 'Milk',
          optionNameSnapshot: 'Oat milk',
          priceDeltaMinorSnapshot: 1500,
        },
      ]);
    });

    it('carries the per-item note through untouched', () => {
      const result = price([
        line({
          menuItemId: 'i-latte',
          optionIds: ['o-regular'],
          notes: 'less sweet',
        }),
      ]);

      expect(result.lines[0].notes).toBe('less sweet');
    });
  });

  describe('availability (E6)', () => {
    it('rejects an 86ed item and names it', () => {
      const catalog = buildCatalog([{ id: 'i-croissant', isAvailable: false }]);

      expect(() => price([line()], catalog)).toThrow(OrderItemUnavailableError);

      try {
        price([line()], catalog);
      } catch (error) {
        expect((error as OrderItemUnavailableError).meta).toEqual({
          itemIds: ['i-croissant'],
          optionIds: [],
        });
      }
    });

    it('rejects an id the catalog cannot price', () => {
      try {
        price([line({ menuItemId: 'i-ghost' })]);
        fail('expected an unavailable error');
      } catch (error) {
        expect(error).toBeInstanceOf(OrderItemUnavailableError);
        expect((error as OrderItemUnavailableError).meta).toEqual({
          itemIds: ['i-ghost'],
          optionIds: [],
        });
      }
    });

    it('rejects an 86ed option and names it', () => {
      try {
        price([
          line({ menuItemId: 'i-latte', optionIds: ['o-regular', 'o-none'] }),
        ]);
        fail('expected an unavailable error');
      } catch (error) {
        expect(error).toBeInstanceOf(OrderItemUnavailableError);
        expect((error as OrderItemUnavailableError).meta).toEqual({
          itemIds: [],
          optionIds: ['o-none'],
        });
      }
    });

    it('collects every unavailable id across the basket in one answer', () => {
      const catalog = buildCatalog([
        { id: 'i-croissant', isAvailable: false },
        { id: 'i-latte', isAvailable: false },
      ]);

      try {
        price(
          [line({ menuItemId: 'i-latte', optionIds: ['o-regular'] }), line()],
          catalog,
        );
        fail('expected an unavailable error');
      } catch (error) {
        expect((error as OrderItemUnavailableError).meta).toEqual({
          itemIds: ['i-latte', 'i-croissant'],
          optionIds: [],
        });
      }
    });

    it('reports a repeated unavailable id once', () => {
      const catalog = buildCatalog([{ id: 'i-croissant', isAvailable: false }]);

      try {
        price([line(), line({ quantity: 2 })], catalog);
        fail('expected an unavailable error');
      } catch (error) {
        expect((error as OrderItemUnavailableError).meta).toEqual({
          itemIds: ['i-croissant'],
          optionIds: [],
        });
      }
    });
  });

  describe('option selection (B2)', () => {
    const violationsOf = (requested: RequestedItem[]) => {
      try {
        price(requested);
        fail('expected a selection error');
      } catch (error) {
        expect(error).toBeInstanceOf(OptionSelectionInvalidError);
        return (error as OptionSelectionInvalidError).meta?.violations;
      }
    };

    it('rejects an option belonging to no group attached to the item', () => {
      expect(violationsOf([line({ optionIds: ['o-large'] })])).toEqual([
        { itemIndex: 0, rule: 'UNKNOWN_OPTION', optionIds: ['o-large'] },
      ]);
    });

    it('rejects an option id the catalog does not have at all', () => {
      expect(
        violationsOf([
          line({ menuItemId: 'i-latte', optionIds: ['o-regular', 'o-ghost'] }),
        ]),
      ).toEqual([
        { itemIndex: 0, rule: 'UNKNOWN_OPTION', optionIds: ['o-ghost'] },
      ]);
    });

    it('rejects the same option twice', () => {
      expect(
        violationsOf([
          line({
            menuItemId: 'i-latte',
            optionIds: ['o-regular', 'o-regular'],
          }),
        ]),
      ).toEqual([
        { itemIndex: 0, rule: 'DUPLICATE_OPTION', optionIds: ['o-regular'] },
      ]);
    });

    it('rejects a basket line missing a required group', () => {
      expect(
        violationsOf([line({ menuItemId: 'i-latte', optionIds: [] })]),
      ).toEqual([
        {
          itemIndex: 0,
          rule: 'MIN_SELECT',
          optionGroupId: 'g-size',
          optionGroupName: 'Size',
          selected: 0,
          allowed: { minSelect: 1, maxSelect: 1 },
        },
      ]);
    });

    it('rejects more selections than a group allows', () => {
      expect(
        violationsOf([
          line({ menuItemId: 'i-latte', optionIds: ['o-small', 'o-large'] }),
        ]),
      ).toEqual([
        {
          itemIndex: 0,
          rule: 'MAX_SELECT',
          optionGroupId: 'g-size',
          optionGroupName: 'Size',
          selected: 2,
          allowed: { minSelect: 1, maxSelect: 1 },
        },
      ]);
    });

    it('accepts a group left empty when its minimum is zero', () => {
      expect(() =>
        price([line({ menuItemId: 'i-latte', optionIds: ['o-regular'] })]),
      ).not.toThrow();
    });

    it('addresses each violation to the line that caused it', () => {
      const violations = violationsOf([
        line({ menuItemId: 'i-croissant' }),
        line({ menuItemId: 'i-latte', optionIds: [] }),
      ]);

      expect(violations).toEqual([
        expect.objectContaining({ itemIndex: 1, rule: 'MIN_SELECT' }),
      ]);
    });

    /**
     * §8 orders the layers shape-then-state, so a malformed basket is answered
     * before a sold-out one. In practice a correctly built kiosk never sends
     * either, and it can only reach this branch by being wrong twice.
     */
    it('answers a selection violation before an availability one', () => {
      const catalog = buildCatalog([{ id: 'i-croissant', isAvailable: false }]);

      expect(() =>
        price(
          [line(), line({ menuItemId: 'i-latte', optionIds: [] })],
          catalog,
        ),
      ).toThrow(OptionSelectionInvalidError);
    });
  });
});
