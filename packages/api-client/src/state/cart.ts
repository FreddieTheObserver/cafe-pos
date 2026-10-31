import type { Menu } from '../types';

export type MenuEntry = Menu['categories'][number]['items'][number];

export interface CartLine {
  /** Local identity; two lines of the same item with different options stay separate. */
  key: string;
  menuItemId: string;
  quantity: number;
  optionIds: string[];
  notes?: string | null;
}

export const MAX_LINES = 30;
export const MAX_QUANTITY = 50;

export const findEntry = (menu: Menu, id: string): MenuEntry | undefined => {
  for (const c of menu.categories)
    for (const i of c.items) if (i.id === id) return i;
  return undefined;
};

/** Options pre-selected when the customer opens an item. */
export const defaultOptionIds = (entry: MenuEntry): string[] =>
  entry.optionGroups.flatMap((g) =>
    g.options.filter((o) => o.isDefault && o.isAvailable).map((o) => o.id),
  );

/** Base plus option deltas, never below zero — the server's rule. */
export const unitPrice = (
  entry: MenuEntry,
  optionIds: readonly string[],
): number => {
  const chosen = new Set(optionIds);
  const delta = entry.optionGroups
    .flatMap((g) => g.options)
    .filter((o) => chosen.has(o.id))
    .reduce((sum, o) => sum + o.priceDeltaMinor, 0);
  return Math.max(0, entry.basePriceMinor + delta);
};

/** Lines whose item has left the menu price at 0 here; `cartIssues` is what reports them. */
export const cartTotal = (menu: Menu, lines: readonly CartLine[]): number =>
  lines.reduce((sum, l) => {
    const entry = findEntry(menu, l.menuItemId);
    return entry ? sum + unitPrice(entry, l.optionIds) * l.quantity : sum;
  }, 0);

export type CartIssue =
  | { kind: 'item-gone'; lineKey: string }
  | { kind: 'item-unavailable'; lineKey: string }
  | { kind: 'option-unavailable'; lineKey: string; optionId: string }
  | {
      kind: 'selection';
      lineKey: string;
      groupId: string;
      rule: 'min' | 'max' | 'unknown-option';
    };

/** Everything wrong with the cart against the menu currently held. Empty means submittable. */
export const cartIssues = (
  menu: Menu,
  lines: readonly CartLine[],
): CartIssue[] => {
  const issues: CartIssue[] = [];
  for (const l of lines) {
    const entry = findEntry(menu, l.menuItemId);
    if (!entry) {
      issues.push({ kind: 'item-gone', lineKey: l.key });
      continue;
    }
    if (!entry.isAvailable)
      issues.push({ kind: 'item-unavailable', lineKey: l.key });

    const known = new Map(
      entry.optionGroups.flatMap((g) =>
        g.options.map((o) => [o.id, o] as const),
      ),
    );
    for (const id of l.optionIds) {
      const o = known.get(id);
      if (!o)
        issues.push({
          kind: 'selection',
          lineKey: l.key,
          groupId: '',
          rule: 'unknown-option',
        });
      else if (!o.isAvailable)
        issues.push({
          kind: 'option-unavailable',
          lineKey: l.key,
          optionId: id,
        });
    }
    for (const g of entry.optionGroups) {
      const n = g.options.filter((o) => l.optionIds.includes(o.id)).length;
      if (n < g.minSelect)
        issues.push({
          kind: 'selection',
          lineKey: l.key,
          groupId: g.id,
          rule: 'min',
        });
      if (n > g.maxSelect)
        issues.push({
          kind: 'selection',
          lineKey: l.key,
          groupId: g.id,
          rule: 'max',
        });
    }
  }
  return issues;
};

const sameOptions = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length &&
  [...a].sort().every((v, i) => v === [...b].sort()[i]);

export const addLine = (
  lines: readonly CartLine[],
  add: Omit<CartLine, 'key'>,
  newKey: () => string,
): CartLine[] => {
  const same = lines.find(
    (l) =>
      l.menuItemId === add.menuItemId &&
      sameOptions(l.optionIds, add.optionIds) &&
      (l.notes ?? null) === (add.notes ?? null),
  );
  if (same) return setQuantity(lines, same.key, same.quantity + add.quantity);
  if (lines.length >= MAX_LINES) return [...lines];
  return [
    ...lines,
    { ...add, quantity: Math.min(add.quantity, MAX_QUANTITY), key: newKey() },
  ];
};

/** Quantity of 0 or less removes the line. */
export const setQuantity = (
  lines: readonly CartLine[],
  key: string,
  quantity: number,
): CartLine[] =>
  quantity <= 0
    ? lines.filter((l) => l.key !== key)
    : lines.map((l) =>
        l.key === key
          ? { ...l, quantity: Math.min(quantity, MAX_QUANTITY) }
          : l,
      );

/** Drops lines that can no longer be sold, so the customer can re-confirm what remains. */
export const dropUnsellable = (
  menu: Menu,
  lines: readonly CartLine[],
): CartLine[] => {
  const bad = new Set(cartIssues(menu, lines).map((i) => i.lineKey));
  return lines.filter((l) => !bad.has(l.key));
};
