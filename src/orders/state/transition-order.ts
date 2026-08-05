import { and, eq } from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import { orders, orderStatusHistory } from '../../database/schema';
import type { ActorType, OrderStatus } from '../../database/schema/enums';
import { OrderInvalidTransitionError } from '../errors/orders.errors';
import type { Transaction } from '../idempotency/idempotency.store';

/** Who or what caused the move (FR-22). `SYSTEM` is a job, with no id. */
export interface TransitionActor {
  actorType: ActorType;
  actorId: string | null;
}

export interface TransitionRequest {
  orderId: string;
  /** The status the caller believes the order is in — the guard's `WHERE`. */
  from: OrderStatus;
  to: OrderStatus;
  actor: TransitionActor;
}

/**
 * Moves an order, atomically, and records who moved it (§4.4, FR-22, E8).
 *
 * The whole design is the `WHERE status = :from` on the update. Two baristas
 * tapping "start" on the same ticket both read `PAID`, both send the same
 * request, and both would otherwise write `IN_PREPARATION` — with the second
 * silently overwriting the first and the history claiming the order started
 * twice. With the guard, the loser updates zero rows and is told so. §4.4 calls
 * this out as the one pattern that resolves both E8 and the E2 webhook race
 * without a lock anywhere.
 *
 * Deliberately a function, not a service: every door that moves an order —
 * this phase's KDS route, Phase 4's webhook and refunds, the expiry job — has
 * to go through the same guard and write the same history row, and a free
 * function is harder to accidentally not use than a method on a class one of
 * them might not inject.
 */
export async function transitionOrder(
  tx: Transaction,
  { orderId, from, to, actor }: TransitionRequest,
): Promise<typeof orders.$inferSelect> {
  const [updated] = await tx
    .update(orders)
    .set({
      status: to,
      /**
       * An order that has left PENDING_PAYMENT does not expire any more, so the
       * column stops meaning anything and is cleared. Left behind, it is a date
       * a KDS would happily render as "expires in 3 minutes" on a drink that is
       * already paid for.
       */
      ...(from === 'PENDING_PAYMENT' ? { expiresAt: null } : {}),
    })
    .where(and(eq(orders.id, orderId), eq(orders.status, from)))
    .returning();

  if (!updated) throw await explainFailure(tx, orderId, to);

  // Same transaction as the update: the audit trail is not allowed to disagree
  // with the row it describes, in either direction.
  await tx.insert(orderStatusHistory).values({
    orderId,
    fromStatus: from,
    toStatus: to,
    actorType: actor.actorType,
    actorId: actor.actorId,
  });

  return updated;
}

/**
 * Zero rows updated means one of two things, and the caller deserves to know
 * which: the order is gone, or it is not where we thought.
 *
 * Re-read rather than inferred, so the 409 carries the status the order is
 * *actually* in — which is the whole value of §9.1's `currentStatus` to a KDS
 * that lost a race and needs to resync.
 */
async function explainFailure(
  tx: Transaction,
  orderId: string,
  requested: OrderStatus,
): Promise<Error> {
  const current = await tx.query.orders.findFirst({
    where: eq(orders.id, orderId),
    columns: { status: true },
  });

  return current === undefined
    ? new ResourceNotFoundError('order', orderId)
    : new OrderInvalidTransitionError(current.status, requested);
}
