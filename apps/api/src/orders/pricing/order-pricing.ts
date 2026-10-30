import {
  OptionSelectionInvalidError,
  OrderItemUnavailableError,
  type OptionSelectionViolation,
} from '../errors/orders.errors';

/**
 * The catalog as pricing needs to see it — the same shape `GET /menu` builds,
 * minus the presentation fields. Declared here rather than imported from the
 * menu service so this module depends on nothing: it is a pure function over
 * plain data, which is what makes the money arithmetic testable without a
 * database (§14).
 */
export interface CatalogOption {
  id: string;
  name: string;
  priceDeltaMinor: number;
  isAvailable: boolean;
}

export interface CatalogOptionGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: CatalogOption[];
}

export interface CatalogItem {
  id: string;
  name: string;
  basePriceMinor: number;
  isAvailable: boolean;
  optionGroups: CatalogOptionGroup[];
}

/** One line of the basket as the client submitted it (§5.3). */
export interface RequestedItem {
  menuItemId: string;
  quantity: number;
  optionIds: string[];
  notes?: string | null;
}

export interface PricedOptionSelection {
  optionId: string;
  groupNameSnapshot: string;
  optionNameSnapshot: string;
  priceDeltaMinorSnapshot: number;
}

export interface PricedLine {
  menuItemId: string;
  nameSnapshot: string;
  unitPriceMinorSnapshot: number;
  quantity: number;
  lineTotalMinor: number;
  notes: string | null;
  options: PricedOptionSelection[];
}

export interface PricedOrder {
  lines: PricedLine[];
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
}

/**
 * Turns a submitted basket into the money the customer owes, or refuses it.
 *
 * This is the function FR-6 is about: the client's totals are advisory, and
 * every number that reaches an order row is computed here from the catalog. It
 * is deliberately pure — catalog in, priced order out, no I/O — because it is
 * the one piece of Phase 3 where being wrong means charging the wrong amount,
 * and a pure function is the only kind that can be exhaustively tested.
 *
 * Validation runs in §8's declared order, shape before state: a basket that the
 * menu never permitted (B2) is answered with 422 before a basket that the menu
 * permitted an hour ago and no longer does (E6) is answered with 409. Each
 * layer reports every violation it finds, so a customer fixes their order once
 * rather than one round trip at a time.
 */
export function priceOrder(
  requested: readonly RequestedItem[],
  catalog: ReadonlyMap<string, CatalogItem>,
  vatBasisPoints: number,
): PricedOrder {
  const resolved = requested.map((line) => resolveLine(line, catalog));

  const violations = resolved.flatMap((line, itemIndex) =>
    line.item === null ? [] : validateSelections(line, itemIndex),
  );
  if (violations.length > 0) throw new OptionSelectionInvalidError(violations);

  // Sets rather than arrays: one 86'd croissant ordered on three lines is one
  // thing for the kiosk to highlight, and insertion order keeps the ids in the
  // order the customer would read them.
  const itemIds = new Set<string>();
  const optionIds = new Set<string>();
  for (const line of resolved) {
    if (line.item === null || !line.item.isAvailable)
      itemIds.add(line.menuItemId);
    for (const option of line.options) {
      if (!option.isAvailable) optionIds.add(option.id);
    }
  }
  if (itemIds.size > 0 || optionIds.size > 0) {
    throw new OrderItemUnavailableError({
      itemIds: [...itemIds],
      optionIds: [...optionIds],
    });
  }

  const lines = resolved.map((line) => priceLine(line));
  const subtotalMinor = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);

  // Subtotal and total are the same number in v1 and both are stored, because
  // the columns mean different things the moment an order-level discount or a
  // service charge exists: subtotal is what the lines add up to, total is what
  // is charged. Collapsing them now would make that a migration later.
  return {
    lines,
    subtotalMinor,
    vatMinor: extractVat(subtotalMinor, vatBasisPoints),
    totalMinor: subtotalMinor,
  };
}

/** A submitted line joined to the catalog; `item: null` means no such id. */
interface ResolvedLine extends RequestedItem {
  item: CatalogItem | null;
  /** The catalog rows the submitted option ids matched, with their group. */
  options: (CatalogOption & { group: CatalogOptionGroup })[];
  /** Submitted ids that matched nothing attached to this item. */
  unknownOptionIds: string[];
  /** Ids submitted more than once on this line. */
  duplicateOptionIds: string[];
}

function resolveLine(
  line: RequestedItem,
  catalog: ReadonlyMap<string, CatalogItem>,
): ResolvedLine {
  const item = catalog.get(line.menuItemId) ?? null;

  // Only groups attached to *this* item are in scope. That is what stops a
  // client pricing an espresso with the cake-slice options.
  const attached = new Map<
    string,
    CatalogOption & { group: CatalogOptionGroup }
  >();
  for (const group of item?.optionGroups ?? []) {
    for (const option of group.options)
      attached.set(option.id, { ...option, group });
  }

  const seen = new Set<string>();
  const duplicateOptionIds: string[] = [];
  const unknownOptionIds: string[] = [];
  const options: (CatalogOption & { group: CatalogOptionGroup })[] = [];

  for (const optionId of line.optionIds) {
    if (seen.has(optionId)) {
      if (!duplicateOptionIds.includes(optionId))
        duplicateOptionIds.push(optionId);
      continue;
    }
    seen.add(optionId);

    const option = attached.get(optionId);
    if (option === undefined) {
      unknownOptionIds.push(optionId);
      continue;
    }
    options.push(option);
  }

  return { ...line, item, options, unknownOptionIds, duplicateOptionIds };
}

function validateSelections(
  line: ResolvedLine,
  itemIndex: number,
): OptionSelectionViolation[] {
  const violations: OptionSelectionViolation[] = [];

  if (line.duplicateOptionIds.length > 0) {
    violations.push({
      itemIndex,
      rule: 'DUPLICATE_OPTION',
      optionIds: line.duplicateOptionIds,
    });
  }
  if (line.unknownOptionIds.length > 0) {
    violations.push({
      itemIndex,
      rule: 'UNKNOWN_OPTION',
      optionIds: line.unknownOptionIds,
    });
  }

  // Bounds are deliberately not reported alongside an id-level problem. A line
  // carrying an option we could not resolve is a line whose intended selection
  // is unknown, and "you also picked too few sizes" computed from what is left
  // would be a guess presented as a rule.
  if (violations.length > 0) return violations;

  for (const group of line.item?.optionGroups ?? []) {
    const selected = line.options.filter((o) => o.group.id === group.id).length;
    if (selected >= group.minSelect && selected <= group.maxSelect) continue;

    violations.push({
      itemIndex,
      rule: selected < group.minSelect ? 'MIN_SELECT' : 'MAX_SELECT',
      optionGroupId: group.id,
      optionGroupName: group.name,
      selected,
      allowed: { minSelect: group.minSelect, maxSelect: group.maxSelect },
    });
  }

  return violations;
}

function priceLine(line: ResolvedLine): PricedLine {
  // `item` is non-null by here: an unresolved id is an availability failure and
  // has already been thrown.
  const item = line.item as CatalogItem;

  const deltas = line.options.reduce((sum, o) => sum + o.priceDeltaMinor, 0);

  /**
   * The floor Phase 2 handed over. `options.price_delta_minor` carries no CHECK
   * — unlike `base_price_minor` — because "Small, −10฿" is a real menu, and
   * only pricing sees a whole line at once.
   *
   * Clamping rather than refusing is the kinder of two bad answers: a menu
   * misconfigured this far is a mistake somewhere in the back office, and a
   * free croissant costs the cafe one croissant, where a rejection closes every
   * kiosk for that item until someone notices. What must not happen is the
   * negative reaching the database, where it would let one line pay for another
   * and make a refund exceed what was captured.
   */
  const unitPriceMinorSnapshot = Math.max(0, item.basePriceMinor + deltas);

  return {
    menuItemId: item.id,
    nameSnapshot: item.name,
    unitPriceMinorSnapshot,
    quantity: line.quantity,
    lineTotalMinor: unitPriceMinorSnapshot * line.quantity,
    notes: line.notes ?? null,
    options: line.options.map((option) => ({
      optionId: option.id,
      groupNameSnapshot: option.group.name,
      optionNameSnapshot: option.name,
      priceDeltaMinorSnapshot: option.priceDeltaMinor,
    })),
  };
}

/**
 * VAT-inclusive extraction (§3.3): the menu price is what the customer pays and
 * the tax is carved back out of it, `vat = total × rate / (1 + rate)`. Nothing
 * here is added to the total — `vatMinor` is a reporting figure, and §5.3's
 * worked example is pinned in the spec beside this.
 *
 * Basis points rather than a float rate so the arithmetic stays in integers
 * until the single rounding at the end.
 */
function extractVat(totalMinor: number, vatBasisPoints: number): number {
  return Math.round((totalMinor * vatBasisPoints) / (10_000 + vatBasisPoints));
}
