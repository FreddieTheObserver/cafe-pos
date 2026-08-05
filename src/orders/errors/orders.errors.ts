import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { OrderChannel, OrderStatus } from '../../database/schema/enums';

/**
 * The orders slice of the §9.2 catalog. As in the catalog module, codes are
 * declared beside the exceptions that raise them, so this object cannot grow an
 * entry no code path produces.
 */
export const OrderErrorCode = {
  ORDER_ITEM_UNAVAILABLE: 'ORDER_ITEM_UNAVAILABLE',
  OPTION_SELECTION_INVALID: 'OPTION_SELECTION_INVALID',
  PRICE_MISMATCH: 'PRICE_MISMATCH',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  ORDER_INVALID_TRANSITION: 'ORDER_INVALID_TRANSITION',
} as const;

/**
 * The order is not where the caller thought it was, or may not go where they
 * asked (§4.4, E8).
 *
 * Covers three situations a client tells apart from `meta`, not from the code:
 * a transition the state machine forbids outright, one this endpoint does not
 * expose even though the machine allows it, and the race where another screen
 * moved the order first. That last one is why `currentStatus` is here — §9.1
 * puts it in `meta` so a KDS that lost the race can resync from the response
 * instead of refetching to find out what happened.
 */
export class OrderInvalidTransitionError extends AppException {
  constructor(currentStatus: OrderStatus, requested: OrderStatus) {
    super({
      code: OrderErrorCode.ORDER_INVALID_TRANSITION,
      status: 409,
      title: 'Invalid order transition',
      detail: `Order is ${currentStatus}; cannot transition to ${requested}.`,
      meta: { currentStatus, requested },
    });
  }
}

/**
 * The `channel` in the body contradicts the credential that sent it (§8).
 *
 * A device token can only place a KIOSK order and a staff token only a COUNTER
 * one, so this field never decides anything — the principal does. It is checked
 * because a client confused about which of the two it is would otherwise
 * silently corrupt the channel split that every §5.2 report and the Z-report
 * are cut along, and that is the kind of error that is only ever noticed a
 * month later.
 *
 * Reuses `VALIDATION_FAILED` rather than inventing a code: §9.2 is the
 * published contract, this is a field-level shape complaint, and 422 already
 * carries `errors[]` for exactly this.
 */
export class OrderChannelMismatchError extends AppException {
  constructor(submitted: OrderChannel, expected: OrderChannel) {
    super({
      code: ErrorCode.VALIDATION_FAILED,
      status: 422,
      title: 'Channel does not match the caller',
      detail: `This credential places ${expected} orders; the request said ${submitted}.`,
      errors: [
        {
          field: 'channel',
          rule: 'principal',
          message: `must be ${expected} for this credential`,
        },
      ],
    });
  }
}

/**
 * Something in the basket cannot be sold right now (E6, FR-3).
 *
 * Covers three cases the kiosk reacts to identically — an 86'd item, an 86'd
 * option, and an item id the catalog does not have. The customer's next move is
 * the same in all three ("that's sold out, pick something else"), and §9.1 says
 * `meta` carries the offending ids precisely so the screen can highlight them.
 *
 * Unknown ids land here rather than in a 404 because the missing thing is a
 * value inside the basket, not the resource the URL addresses — the same call
 * `CATEGORY_UNKNOWN` makes one module over. They are folded in with sold-out
 * rather than given their own code because items are soft-deleted (B8): an id
 * the catalog cannot price is either a client bug or a row that was genuinely
 * removed, and neither is worth a second error screen.
 *
 * 409 rather than 422 because it is a *state* problem in §8's three-layer
 * model: the request is well-formed and was valid when the menu was fetched.
 * That is also why an 86'd option is reported here instead of as a B2
 * selection error — "the oat milk ran out" is the world changing under a
 * correct request, while "that option isn't on that drink" is a malformed one.
 */
export class OrderItemUnavailableError extends AppException {
  constructor(unavailable: { itemIds: string[]; optionIds: string[] }) {
    super({
      code: OrderErrorCode.ORDER_ITEM_UNAVAILABLE,
      status: 409,
      title: 'Item unavailable',
      detail: 'One or more items or options in this order cannot be sold.',
      meta: { ...unavailable },
    });
  }
}

/**
 * The option selections do not form a valid basket line (B2).
 *
 * Every case here is a client that built a request the menu never permitted:
 * an option id that belongs to no group attached to that item, the same option
 * twice, or a count outside a group's min/max. All of them are shape problems
 * against the menu document the kiosk was holding, so 422 with per-line detail
 * rather than 409 — no amount of waiting makes them valid.
 *
 * Violations are reported for the whole basket at once. A customer who mis-set
 * two drinks should get both back in one response, not discover the second
 * after fixing the first.
 */
export class OptionSelectionInvalidError extends AppException {
  constructor(violations: OptionSelectionViolation[]) {
    super({
      code: OrderErrorCode.OPTION_SELECTION_INVALID,
      status: 422,
      title: 'Invalid option selection',
      detail:
        'One or more items have option selections the menu does not allow.',
      meta: { violations },
    });
  }
}

/** One basket line's quarrel with the menu, addressed by its index in `items[]`. */
export interface OptionSelectionViolation {
  /** Index into the submitted `items[]`, so a kiosk can mark the right line. */
  itemIndex: number;
  rule: 'UNKNOWN_OPTION' | 'DUPLICATE_OPTION' | 'MIN_SELECT' | 'MAX_SELECT';
  /** Present for the group-bound rules; absent when the option is simply unknown. */
  optionGroupId?: string;
  optionGroupName?: string;
  /** The offending option ids for the id-shaped rules. */
  optionIds?: string[];
  /** Bounds context for MIN_SELECT / MAX_SELECT, so the message writes itself. */
  selected?: number;
  allowed?: { minSelect: number; maxSelect: number };
}

/**
 * One idempotency key, two different requests (§5.7).
 *
 * The key means "this is the same logical attempt as before", so the same key
 * carrying a different basket is a client bug — most often a kiosk that reused
 * a key across two customers, which is exactly the mistake that would otherwise
 * hand the second customer the first one's order.
 *
 * Refusing is the only safe answer. Serving the stored response would give the
 * second customer a receipt for a basket they did not order; serving the new
 * one would make the key meaningless.
 */
export class IdempotencyConflictError extends AppException {
  constructor() {
    super({
      code: OrderErrorCode.IDEMPOTENCY_CONFLICT,
      status: 409,
      title: 'Idempotency key reused',
      detail:
        'That Idempotency-Key was already used for a different request. Use a new key for a new order.',
    });
  }
}

/**
 * The server's total disagrees with the one the kiosk displayed (E7).
 *
 * The check exists because the alternative is charging a customer a number
 * they never saw. A price edit that lands between menu fetch and submit is
 * rare and completely invisible to the customer standing at the tablet, so the
 * order is refused and the kiosk re-prices rather than silently taking the new
 * amount.
 *
 * `expectedTotalMinor` is optional on the request (§8): a counter cashier
 * reading prices off the same screen they just edited has no stale total to
 * guard against. Sending it is what buys the guarantee.
 */
export class PriceMismatchError extends AppException {
  constructor(expectedTotalMinor: number, actualTotalMinor: number) {
    super({
      code: OrderErrorCode.PRICE_MISMATCH,
      status: 409,
      title: 'Price mismatch',
      detail:
        'The order total has changed since the menu was loaded. Re-price the basket and submit again.',
      // Both numbers, per §9.1 — the kiosk shows the customer what moved.
      meta: { expectedTotalMinor, actualTotalMinor },
    });
  }
}
