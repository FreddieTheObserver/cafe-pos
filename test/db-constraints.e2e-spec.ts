import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';

/**
 * §7.4 says the money invariants live in the schema as well as the app — "a bug
 * in a future code path hits a constraint, not the books". That promise is only
 * worth anything if the constraints are actually armed in a migrated database,
 * which is what this suite checks against real Postgres.
 *
 * It inserts through the Drizzle schema objects rather than raw SQL on purpose:
 * that also proves the TypeScript schema and the migrated tables agree on every
 * column name and type.
 */
describe('database constraints (integration)', () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  // Far-future day so a failed run can never collide with real seed data.
  const BUSINESS_DAY = '2099-01-01';
  const userId = uuidv7();
  const deviceId = uuidv7();
  const orderId = uuidv7();
  const livePaymentId = uuidv7();

  /** Postgres SQLSTATE codes we assert on. */
  const UNIQUE_VIOLATION = '23505';
  const CHECK_VIOLATION = '23514';

  interface PgError {
    code?: string;
    constraint?: string;
  }

  /** Drizzle wraps driver errors, so the SQLSTATE lives on the cause. */
  function pgErrorOf(err: unknown): PgError {
    const cause = (err as { cause?: unknown }).cause;
    return (cause ?? err) as PgError;
  }

  /** Runs `insert`, expecting Postgres — not the app — to reject it. */
  async function expectRejection(
    insert: () => Promise<unknown>,
  ): Promise<PgError> {
    try {
      await insert();
    } catch (err) {
      return pgErrorOf(err);
    }
    throw new Error(
      'expected the database to reject this write, but it did not',
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });

    await db.insert(schema.users).values({
      id: userId,
      email: `constraints-${userId}@cafepos.test`,
      passwordHash: 'x',
      displayName: 'Constraint Fixture',
      role: 'MANAGER',
    });
    await db.insert(schema.kioskDevices).values({
      id: deviceId,
      name: 'Fixture Kiosk',
      status: 'ACTIVE',
      registeredBy: userId,
    });
    await db.insert(schema.orders).values({
      id: orderId,
      orderNumber: 'A-001',
      businessDay: BUSINESS_DAY,
      channel: 'KIOSK',
      status: 'PENDING_PAYMENT',
      kioskDeviceId: deviceId,
      subtotalMinor: 10000,
      vatMinor: 700,
      totalMinor: 10700,
    });
    await db.insert(schema.payments).values({
      id: livePaymentId,
      orderId,
      provider: 'STRIPE',
      method: 'CARD',
      status: 'PENDING',
      amountMinor: 10700,
    });
  });

  afterAll(async () => {
    await db
      .delete(schema.payments)
      .where(eq(schema.payments.orderId, orderId));
    await db.delete(schema.orders).where(eq(schema.orders.id, orderId));
    await db
      .delete(schema.kioskDevices)
      .where(eq(schema.kioskDevices.id, deviceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await pool.end();
  });

  it('accepts the seeded fixtures, so later rejections mean something', async () => {
    const order = await db.query.orders.findFirst({
      where: eq(schema.orders.id, orderId),
    });

    expect(order?.orderNumber).toBe('A-001');
    expect(order?.currency).toBe('THB');
  });

  describe('B4 — at most one live payment per order', () => {
    it('rejects a second PENDING payment on the same order', async () => {
      const err = await expectRejection(() =>
        db.insert(schema.payments).values({
          id: uuidv7(),
          orderId,
          provider: 'STRIPE',
          method: 'PROMPTPAY',
          status: 'PENDING',
          amountMinor: 10700,
        }),
      );

      expect(err.code).toBe(UNIQUE_VIOLATION);
      expect(err.constraint).toBe('one_live_payment');
    });

    it('allows a second payment once the first reached a terminal state', async () => {
      await db
        .update(schema.payments)
        .set({ status: 'FAILED' })
        .where(eq(schema.payments.id, livePaymentId));

      const retryId = uuidv7();
      await db.insert(schema.payments).values({
        id: retryId,
        orderId,
        provider: 'STRIPE',
        method: 'CARD',
        status: 'PENDING',
        amountMinor: 10700,
      });

      const rows = await db
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.orderId, orderId));
      expect(rows).toHaveLength(2);

      // Restore the fixture state for any later test in this file.
      await db.delete(schema.payments).where(eq(schema.payments.id, retryId));
      await db
        .update(schema.payments)
        .set({ status: 'PENDING' })
        .where(eq(schema.payments.id, livePaymentId));
    });
  });

  describe('order integrity', () => {
    it('rejects an order placed by neither a device nor a user', async () => {
      const err = await expectRejection(() =>
        db.insert(schema.orders).values({
          id: uuidv7(),
          orderNumber: 'A-002',
          businessDay: BUSINESS_DAY,
          channel: 'KIOSK',
          status: 'DRAFT',
          subtotalMinor: 0,
          vatMinor: 0,
          totalMinor: 0,
        }),
      );

      expect(err.code).toBe(CHECK_VIOLATION);
      expect(err.constraint).toBe('orders_actor_check');
    });

    it('rejects a duplicate queue number within one business day', async () => {
      const err = await expectRejection(() =>
        db.insert(schema.orders).values({
          id: uuidv7(),
          orderNumber: 'A-001',
          businessDay: BUSINESS_DAY,
          channel: 'COUNTER',
          status: 'DRAFT',
          createdByUserId: userId,
          subtotalMinor: 0,
          vatMinor: 0,
          totalMinor: 0,
        }),
      );

      expect(err.code).toBe(UNIQUE_VIOLATION);
      expect(err.constraint).toBe('orders_business_day_number_unique');
    });

    it('rejects a line quantity outside 1..50', async () => {
      const err = await expectRejection(() =>
        db.insert(schema.orderItems).values({
          id: uuidv7(),
          orderId,
          menuItemId: uuidv7(),
          nameSnapshot: 'Latte',
          unitPriceMinorSnapshot: 10000,
          quantity: 51,
          lineTotalMinor: 510000,
        }),
      );

      expect(err.code).toBe(CHECK_VIOLATION);
      expect(err.constraint).toBe('order_items_quantity_check');
    });
  });

  describe('money integrity', () => {
    it('rejects a non-positive payment amount', async () => {
      const err = await expectRejection(() =>
        db.insert(schema.payments).values({
          id: uuidv7(),
          orderId: uuidv7(),
          provider: 'CASH',
          method: 'CASH',
          status: 'SUCCEEDED',
          amountMinor: 0,
        }),
      );

      expect(err.code).toBe(CHECK_VIOLATION);
      expect(err.constraint).toBe('payments_amount_check');
    });

    it('rejects a status outside the documented set', async () => {
      const err = await expectRejection(() =>
        db.insert(schema.payments).values({
          id: uuidv7(),
          orderId,
          provider: 'STRIPE',
          method: 'CARD',
          // @ts-expect-error the schema's enum tuple rejects this at compile
          // time too — the point here is that the DB is the last line of defence.
          status: 'REVERSED',
          amountMinor: 100,
        }),
      );

      expect(err.code).toBe(CHECK_VIOLATION);
      expect(err.constraint).toBe('payments_status_check');
    });
  });

  describe('identity', () => {
    it('treats emails case-insensitively via citext', async () => {
      const err = await expectRejection(() =>
        db.insert(schema.users).values({
          id: uuidv7(),
          email: `CONSTRAINTS-${userId}@CAFEPOS.TEST`.toUpperCase(),
          passwordHash: 'x',
          displayName: 'Case Clash',
          role: 'CASHIER',
        }),
      );

      expect(err.code).toBe(UNIQUE_VIOLATION);
      expect(err.constraint).toBe('users_email_unique');
    });
  });
});
