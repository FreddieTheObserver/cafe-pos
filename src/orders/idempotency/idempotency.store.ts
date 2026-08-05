import { eq } from 'drizzle-orm';
import { isUniqueViolation } from '../../common/database/postgres-errors';
import type { Database } from '../../database/database.module';
import { idempotencyKeys } from '../../database/schema';
import { IdempotencyConflictError } from '../errors/orders.errors';

/** A Drizzle transaction handle — the same API as the client, scoped to one tx. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Raised when the key already exists, so the caller knows to replay rather than
 * to fail.
 *
 * A private signal rather than a check on the SQLSTATE at the call site: the
 * surrounding transaction also writes `orders`, which carries its own unique
 * index on `(business_day, order_number)`. Treating *any* unique violation as
 * "already seen this key" would quietly turn a queue-number collision — a real
 * bug — into a replay of somebody else's order.
 */
class KeyAlreadyReserved extends Error {}

/**
 * Claims a key for the transaction that is about to do the work (§5.7).
 *
 * The row goes in **before** there is a response to store, and that is the
 * whole concurrency design. A retry arriving while the original is still in
 * flight — which is precisely the E5 case, since the client only retries after
 * giving up waiting — blocks on this primary key instead of racing past it into
 * a second order. When the original commits, the retry's insert fails and it
 * replays; when the original rolls back, the retry's insert succeeds and it
 * does the work itself.
 *
 * That second case is why a refused order stores nothing: the reservation dies
 * with the transaction, so a kiosk may retry an order that failed because an
 * item was briefly sold out.
 */
export async function reserveKey(
  tx: Transaction,
  key: string,
  requestHash: string,
  expiresAt: Date,
): Promise<void> {
  try {
    await tx.insert(idempotencyKeys).values({ key, requestHash, expiresAt });
  } catch (error) {
    if (isUniqueViolation(error)) throw new KeyAlreadyReserved();
    throw error;
  }
}

/** Stores the response the key now stands for, in the same transaction. */
export async function completeKey(
  tx: Transaction,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ responseStatus: status, responseBody: body })
    .where(eq(idempotencyKeys.key, key));
}

export const isKeyAlreadyReserved = (error: unknown): boolean =>
  error instanceof KeyAlreadyReserved;

/**
 * Returns what the first request answered, or refuses the key.
 *
 * Read after the losing transaction has rolled back, so this sees the winner's
 * committed row. A stored hash that disagrees means the key was reused for a
 * different basket (§5.7) — the client bug that would otherwise hand one
 * customer another's order.
 */
export async function replayKey<T>(
  db: Database,
  key: string,
  requestHash: string,
): Promise<T> {
  const [stored] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key));

  // Gone between the failed insert and this read: the cleanup job (§7.5)
  // removing a key that expired in that window. Rare enough to treat as a
  // conflict — the caller retries with a new key — and far better than
  // inventing a response.
  if (!stored) throw new IdempotencyConflictError();
  if (stored.requestHash !== requestHash) throw new IdempotencyConflictError();

  /**
   * A committed row with no response should be unreachable: the insert and the
   * update are in one transaction, so a reservation is only ever visible to
   * another session once the response is beside it. If it ever happens, the
   * honest answer is to refuse rather than to synthesise a receipt.
   */
  if (stored.responseBody === null) throw new IdempotencyConflictError();

  return stored.responseBody as T;
}
