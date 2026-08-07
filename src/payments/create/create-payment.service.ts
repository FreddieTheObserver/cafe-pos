import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { isUniqueViolation } from '../../common/database/postgres-errors';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders, payments } from '../../database/schema';
import type { PaymentMethod, PaymentStatus } from '../../database/schema/enums';
import type { Principal } from '../../identity/principal';
import { IdempotencyConflictError } from '../../orders/errors/orders.errors';
import {
  completeKey,
  completedResponseFor,
  isKeyAlreadyReserved,
  replayKey,
  reserveKey,
} from '../../orders/idempotency/idempotency.store';
import { hashRequest } from '../../orders/idempotency/request-hash';
import { transitionOrder } from '../../orders/state/transition-order';
import {
  CashPaymentNotAllowedError,
  CashTenderInsufficientError,
  OrderExpiredError,
  OrderNotPayableError,
  PaymentAlreadyActiveError,
} from '../errors/payments.errors';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../provider/payment-provider';

/** Statuses that make a payment "live" for B4 — the partial unique index's set. */
const LIVE: readonly PaymentStatus[] = ['PENDING', 'PROCESSING'];

export interface CreatePaymentInput {
  method: PaymentMethod;
  /** Counter only, and only for CASH: what the customer handed over. */
  cashTenderedMinor?: number;
}

/**
 * What the kiosk needs to do next, if anything.
 *
 * Cash is settled by the time this returns, so it carries none. A gateway
 * payment carries the client secret and nothing else — §5.3's `DISPLAY_QR`
 * variant is gone with the rail-picking it belonged to (see below).
 */
export type ClientAction = {
  type: 'CONFIRM_WITH_CLIENT_SECRET';
  clientSecret: string;
};

export interface PaymentView {
  id: string;
  status: PaymentStatus;
  /**
   * Null for a gateway payment, and that is not an omission.
   *
   * With dynamic payment methods the customer chooses the rail inside Stripe's
   * Payment Element, *after* this intent exists, so at 201 nobody knows yet.
   * The webhook resolves it (§4.2). The column is nullable for the same reason.
   */
  method: PaymentMethod | null;
  amountMinor: number;
  currency: string;
  provider: 'STRIPE' | 'CASH';
  clientAction: ClientAction | null;
}

/**
 * `POST /orders/:id/payments` — opening a payment against an order (FR-11, §5.2).
 *
 * **Diverges from §5.2 on purpose.** The spec has the kiosk naming a rail
 * (`{"method":"PROMPTPAY"}` → a QR in the response) and echoing it back. The
 * shipped gateway does not work that way: `createIntent` omits
 * `payment_method_types` so Stripe ranks and presents the eligible rails, which
 * is why `payments.method` is nullable and why the webhook is what finally says
 * what was used. `method` is still accepted here because it carries the one
 * distinction that *is* ours to make — cash at the counter versus the gateway —
 * but for CARD and PROMPTPAY the value is not persisted and not honoured as a
 * choice of rail. Enabling PromptPay is a Dashboard setting, not a request body.
 */
@Injectable()
export class CreatePaymentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async create(
    principal: Principal,
    orderId: string,
    input: CreatePaymentInput,
    idempotencyKey?: string,
  ): Promise<{ payment: PaymentView; replayed: boolean }> {
    const requestHash =
      idempotencyKey === undefined
        ? null
        : hashRequest(`${scopeOf(principal)}:payments:${orderId}`, input);

    /**
     * Checked before anything is validated, and that ordering is the point.
     *
     * A retried cash payment arrives after the first one moved the order to
     * PAID, so running the payability checks first would refuse the retry with
     * a 409 about state the retry itself caused — the exact failure §5.7 exists
     * to prevent. The authoritative reservation still happens inside the
     * transaction below; this only skips work whose answer is already stored.
     */
    if (idempotencyKey !== undefined && requestHash !== null) {
      const answered = await completedResponseFor(this.db, idempotencyKey);
      if (answered !== undefined) {
        if (answered.requestHash !== requestHash) {
          throw new IdempotencyConflictError();
        }
        return {
          payment: answered.responseBody as PaymentView,
          replayed: true,
        };
      }
    }

    const order = await this.loadPayableOrder(principal, orderId);

    return input.method === 'CASH'
      ? this.takeCash(principal, order, input, idempotencyKey, requestHash)
      : this.openGatewayPayment(order, idempotencyKey, requestHash);
  }

  /**
   * Reads the order and refuses every reason it cannot take money (§4.4, B4).
   *
   * Done before anything is created, so the common refusals cost no gateway
   * call. It is not a substitute for the constraint: `one_live_payment` is a
   * partial unique index and two tills racing are settled there, not here.
   */
  private async loadPayableOrder(principal: Principal, orderId: string) {
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: {
        id: true,
        status: true,
        totalMinor: true,
        currency: true,
        kioskDeviceId: true,
      },
    });
    if (order === undefined) throw new ResourceNotFoundError('order', orderId);

    /**
     * 404, not 403 (§6.4). A kiosk asking about an order that is not its own
     * learns only that it has no such order — telling it "forbidden" would
     * confirm the id exists, which is an enumeration oracle for a token sitting
     * in an unattended machine.
     */
    if (
      principal.type === 'device' &&
      order.kioskDeviceId !== principal.deviceId
    ) {
      throw new ResourceNotFoundError('order', orderId);
    }

    if (order.status === 'EXPIRED') throw new OrderExpiredError();
    if (order.status !== 'PENDING_PAYMENT') {
      throw new OrderNotPayableError(order.status);
    }

    const live = await this.db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(eq(payments.orderId, orderId), inArray(payments.status, LIVE)),
      );
    if (live.length > 0) throw new PaymentAlreadyActiveError(live[0].id);

    return order;
  }

  /**
   * Cash, settled in one transaction (B6).
   *
   * No gateway and no webhook: the money is in the drawer by the time the
   * cashier taps the button, so the payment is born SUCCEEDED and the order
   * moves to PAID beside it. That is still §4.4's rule holding rather than an
   * exception to it — the order becomes PAID because a payment succeeded.
   */
  private async takeCash(
    principal: Principal,
    order: { id: string; totalMinor: number; currency: string },
    input: CreatePaymentInput,
    idempotencyKey: string | undefined,
    requestHash: string | null,
  ): Promise<{ payment: PaymentView; replayed: boolean }> {
    // There is no drawer at a kiosk and nobody standing at it to open one.
    if (principal.type === 'device') throw new CashPaymentNotAllowedError();

    /**
     * The DTO already refuses CASH with no tender at all, so `undefined` here
     * would be a wiring fault rather than a client one — but it is narrowed
     * anyway, and lands on the same error a short tender does, which is the
     * honest description either way.
     */
    const tendered = input.cashTenderedMinor;
    if (tendered === undefined || tendered < order.totalMinor) {
      throw new CashTenderInsufficientError(tendered ?? 0, order.totalMinor);
    }

    return this.write(idempotencyKey, requestHash, async (tx) => {
      const paymentId = await this.insertPayment(tx, order.id, {
        orderId: order.id,
        provider: 'CASH',
        method: 'CASH',
        status: 'SUCCEEDED',
        amountMinor: order.totalMinor,
        currency: order.currency,
        cashTenderedMinor: tendered,
        idempotencyKey: idempotencyKey ?? null,
      });

      await transitionOrder(tx, {
        orderId: order.id,
        from: 'PENDING_PAYMENT',
        to: 'PAID',
        actor: { actorType: 'USER', actorId: principal.userId },
      });

      return {
        id: paymentId,
        status: 'SUCCEEDED' as const,
        method: 'CASH' as const,
        amountMinor: order.totalMinor,
        currency: order.currency,
        provider: 'CASH' as const,
        clientAction: null,
      };
    });
  }

  /**
   * A gateway payment: the intent first, then the row.
   *
   * That order is deliberate. Creating the intent after claiming the row would
   * leave a PENDING payment behind whenever Stripe is unreachable — and a
   * PENDING payment is exactly what B4 refuses to let anyone past, so a
   * gateway blip would lock the customer out of paying at all. An intent
   * created and then abandoned is the cheaper failure: nobody is charged, and
   * Stripe expires it on its own.
   */
  private async openGatewayPayment(
    order: { id: string; totalMinor: number; currency: string },
    idempotencyKey: string | undefined,
    requestHash: string | null,
  ): Promise<{ payment: PaymentView; replayed: boolean }> {
    const intent = await this.provider.createIntent({
      amountMinor: order.totalMinor,
      currency: order.currency,
      idempotencyKey,
      // Echoed on every webhook, so an event can be matched back to our rows
      // without trusting anything the client said.
      metadata: { orderId: order.id },
    });

    return this.write(idempotencyKey, requestHash, async (tx) => {
      const paymentId = await this.insertPayment(tx, order.id, {
        orderId: order.id,
        provider: 'STRIPE',
        providerIntentId: intent.intentId,
        status: 'PENDING',
        amountMinor: order.totalMinor,
        currency: order.currency,
        idempotencyKey: idempotencyKey ?? null,
      });

      return {
        id: paymentId,
        status: 'PENDING' as const,
        // Unknown until the customer picks inside the Payment Element.
        method: null,
        amountMinor: order.totalMinor,
        currency: order.currency,
        provider: 'STRIPE' as const,
        clientAction: {
          type: 'CONFIRM_WITH_CLIENT_SECRET' as const,
          clientSecret: intent.clientSecret,
        },
      };
    });
  }

  /**
   * Runs the write under the key, or replays what the key already answered.
   *
   * The same shape `OrdersService.create` uses, for the same §5.7 reason: the
   * reservation shares the transaction with the work, so a refused payment
   * stores nothing and the caller may retry.
   */
  /**
   * Turns the `one_live_payment` constraint into the 409 §5.2 promises.
   *
   * `loadPayableOrder`'s check is an optimisation — it runs outside any
   * transaction, so two tills racing both pass it and the partial unique index
   * is what actually settles them. Without this, the loser's insert raises a
   * bare SQLSTATE 23505 that no filter recognises, and the caller gets a 500
   * INTERNAL: read by most clients as "the server is broken", answered with a
   * retry, which is the exact wrong response to "someone else got there first".
   */
  private async insertPayment(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    orderId: string,
    values: typeof payments.$inferInsert,
  ): Promise<string> {
    try {
      const [row] = await tx
        .insert(payments)
        .values(values)
        .returning({ id: payments.id });
      return row.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // Re-read so the 409 carries the id that won, which is what lets a
      // racing client reuse that payment instead of opening another.
      const [winner] = await this.db
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(eq(payments.orderId, orderId), inArray(payments.status, LIVE)),
        );

      throw new PaymentAlreadyActiveError(winner?.id ?? orderId);
    }
  }

  private async write(
    idempotencyKey: string | undefined,
    requestHash: string | null,
    work: (
      tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    ) => Promise<PaymentView>,
  ): Promise<{ payment: PaymentView; replayed: boolean }> {
    try {
      const payment = await this.db.transaction(async (tx) => {
        if (idempotencyKey !== undefined && requestHash !== null) {
          await reserveKey(tx, idempotencyKey, requestHash, this.keyExpiry());
        }

        const view = await work(tx);

        if (idempotencyKey !== undefined) {
          await completeKey(tx, idempotencyKey, 201, view);
        }
        return view;
      });

      return { payment, replayed: false };
    } catch (error) {
      if (
        !isKeyAlreadyReserved(error) ||
        idempotencyKey === undefined ||
        requestHash === null
      ) {
        throw error;
      }

      return {
        payment: await replayKey<PaymentView>(
          this.db,
          idempotencyKey,
          requestHash,
        ),
        replayed: true,
      };
    }
  }

  /** 24 hours (§5.7), matching `OrdersService`; §7.5's job reaps the row. */
  private keyExpiry(): Date {
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
  }
}

/** Keys are scoped to their caller, so a guessed one cannot pull back a stranger's payment. */
const scopeOf = (principal: Principal): string =>
  principal.type === 'device'
    ? `device:${principal.deviceId}`
    : `user:${principal.userId}`;
