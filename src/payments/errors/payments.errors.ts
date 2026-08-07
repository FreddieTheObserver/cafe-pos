import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { OrderStatus } from '../../database/schema/enums';

/**
 * The payments slice of the §9.2 catalog.
 *
 * `REFUND_EXCEEDS_REMAINING` and `PAYMENT_NOT_REFUNDABLE` were once absent from
 * here, on the grounds that a system issuing no gateway refunds has no
 * remaining-amount arithmetic to get wrong. That was wrong: no *money* moves
 * through Stripe on a refund, but the amounts are still tracked — the `refunds`
 * table carries `amount_minor` precisely so a partial refund is a record rather
 * than a rounding of the order — and E9's `amount ≤ captured − already
 * refunded` is arithmetic whether the till or the gateway settles it. Refusing
 * to over-refund is the check; who hands over the cash is not the point.
 *
 * As elsewhere, codes live beside the exceptions that raise them so this object
 * cannot grow an entry nothing produces.
 */
export const PaymentErrorCode = {
  PAYMENT_ALREADY_ACTIVE: 'PAYMENT_ALREADY_ACTIVE',
  ORDER_NOT_PAYABLE: 'ORDER_NOT_PAYABLE',
  ORDER_EXPIRED: 'ORDER_EXPIRED',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  REFUND_EXCEEDS_REMAINING: 'REFUND_EXCEEDS_REMAINING',
  PAYMENT_NOT_REFUNDABLE: 'PAYMENT_NOT_REFUNDABLE',
  CASH_TENDER_INSUFFICIENT: 'CASH_TENDER_INSUFFICIENT',
} as const;

/**
 * A live payment already exists for this order (B4).
 *
 * The schema enforces this too — `one_live_payment` is a partial unique index
 * over `(order_id) WHERE status IN ('PENDING','PROCESSING')` — so this error is
 * the application saying it first, with a usable message, rather than letting a
 * constraint violation surface as a 500.
 *
 * The rule exists because two live intents against one order is how a customer
 * gets charged twice: both can succeed, and only one of them can be the reason
 * the order is PAID. A customer who wants to switch from the QR screen to a
 * card cancels the first attempt; they do not open a second one alongside it.
 */
export class PaymentAlreadyActiveError extends AppException {
  constructor(activePaymentId: string) {
    super({
      code: PaymentErrorCode.PAYMENT_ALREADY_ACTIVE,
      status: 409,
      title: 'A payment is already in progress',
      detail:
        'This order already has a payment awaiting completion. Cancel it before starting another.',
      meta: { activePaymentId },
    });
  }
}

/**
 * The order is not in a state that can accept money (§4.4).
 *
 * PENDING_PAYMENT is the only status a payment may open against. A DRAFT has
 * not been checked out and has no queue number yet; anything at PAID or beyond
 * has already been paid for, and taking a second payment for it is the exact
 * outcome B4 exists to prevent.
 *
 * `currentStatus` rides along for the same reason it does on an invalid
 * transition: a kiosk that lost a race can resync from the response instead of
 * refetching to discover what happened.
 */
export class OrderNotPayableError extends AppException {
  constructor(currentStatus: OrderStatus) {
    super({
      code: PaymentErrorCode.ORDER_NOT_PAYABLE,
      status: 409,
      title: 'Order cannot be paid',
      detail: `Order is ${currentStatus}; only a PENDING_PAYMENT order accepts a payment.`,
      meta: { currentStatus },
    });
  }
}

/**
 * The order aged out before the customer paid (FR-10, E3).
 *
 * Separate from `ORDER_NOT_PAYABLE` even though EXPIRED is also just a status,
 * because the customer-facing consequence is different and the kiosk says
 * something different about it. "That order timed out, start again" is a
 * recoverable prompt; "this order cannot be paid" is an error screen.
 */
export class OrderExpiredError extends AppException {
  constructor() {
    super({
      code: PaymentErrorCode.ORDER_EXPIRED,
      status: 409,
      title: 'Order expired',
      detail:
        'This order held its queue number too long and has expired. Please order again.',
    });
  }
}

/**
 * The webhook body did not carry a signature this endpoint trusts (§10.1).
 *
 * This endpoint is public — it has to be, the gateway calls it — so the
 * signature *is* the authentication. A body that fails it did not come from the
 * gateway, whatever it claims, and is never parsed for meaning.
 *
 * 400 rather than 401 because §9.2 says so, and because the gateway's retry
 * behaviour is what actually matters here: a 400 is a permanent rejection it
 * will eventually stop retrying, which is right for a body that can never
 * become valid. Reserving 5xx for *processing* failures is what makes retries
 * mean "we could not handle this yet" rather than "we did not believe you".
 *
 * The detail says nothing about which check failed. An attacker probing the
 * endpoint learns whether a signature was missing, malformed or simply wrong
 * only from our logs, never from the response.
 */
export class WebhookSignatureInvalidError extends AppException {
  constructor() {
    super({
      code: PaymentErrorCode.WEBHOOK_SIGNATURE_INVALID,
      status: 400,
      title: 'Invalid webhook signature',
      detail: 'The request signature could not be verified.',
    });
  }
}

/**
 * The customer did not hand over enough (§8's `cashTenderedMinor ≥ total`).
 *
 * Not in §9.2's catalog, and added anyway. The alternative was reusing
 * `ORDER_NOT_PAYABLE`, which produced a response that contradicted itself —
 * "Order is PENDING_PAYMENT; only a PENDING_PAYMENT order accepts a payment"
 * — telling a cashier the order was in the wrong state when the order was
 * fine and the money was short. A code the catalog has to grow is cheaper than
 * a message nobody can act on.
 *
 * 422 rather than 409, matching `RefundExceedsRemainingError` and the DTO's
 * refusal of a missing tender: the order is in exactly the right state and it
 * is the *number* that is wrong, which the till can fix by taking more cash.
 */
export class CashTenderInsufficientError extends AppException {
  constructor(tenderedMinor: number, requiredMinor: number) {
    super({
      code: PaymentErrorCode.CASH_TENDER_INSUFFICIENT,
      status: 422,
      title: 'Cash tendered is less than the total',
      detail: `Tendered ${tenderedMinor}, but the order comes to ${requiredMinor}.`,
      meta: { tenderedMinor, requiredMinor },
    });
  }
}

/**
 * The refund would take back more than was captured (E9).
 *
 * 422 rather than 409: the request is well-formed and the payment is in a state
 * that accepts refunds — it is the *number* that is wrong, and a client that
 * subtracts differently can fix it by sending a smaller one. `remainingMinor`
 * rides along so a manager's screen can show what is actually left instead of
 * making them work it out from the receipt.
 */
export class RefundExceedsRemainingError extends AppException {
  constructor(requestedMinor: number, remainingMinor: number) {
    super({
      code: PaymentErrorCode.REFUND_EXCEEDS_REMAINING,
      status: 422,
      title: 'Refund is larger than what is left',
      detail: `Requested ${requestedMinor}, but only ${remainingMinor} of this payment has not been refunded.`,
      meta: { requestedMinor, remainingMinor },
    });
  }
}

/**
 * This payment cannot be refunded (§5.2).
 *
 * Two reasons reach here and both are about state, not arithmetic: money that
 * was never captured (a payment that failed, was cancelled, or is still in
 * flight) cannot be given back, and §3.3 confines refunds to the business day
 * that took them — a till reconciled at close cannot be reopened by a refund
 * against yesterday.
 */
export class PaymentNotRefundableError extends AppException {
  constructor(reason: string) {
    super({
      code: PaymentErrorCode.PAYMENT_NOT_REFUNDABLE,
      status: 409,
      title: 'Payment cannot be refunded',
      detail: reason,
    });
  }
}

/**
 * A kiosk tried to take cash (B6).
 *
 * There is no cash drawer at a kiosk and nobody standing at it to open one, so
 * a device token naming `CASH` is either a misconfigured client or someone
 * trying to mark an order paid without paying. Neither should get a payment
 * row.
 *
 * Reuses `FORBIDDEN_ROLE` rather than minting a code: this is exactly the
 * §6.4 matrix speaking ("Cash payment — ADMIN, MANAGER, CASHIER"). It cannot
 * be enforced by the route guard alone, because the same route serves card and
 * QR payments that a kiosk *is* allowed to open — the method in the body is
 * what makes it forbidden.
 */
export class CashPaymentNotAllowedError extends AppException {
  constructor() {
    super({
      code: ErrorCode.FORBIDDEN_ROLE,
      status: 403,
      title: 'Cash is a counter payment',
      detail: 'Cash can only be taken at the counter by a cashier or above.',
    });
  }
}
