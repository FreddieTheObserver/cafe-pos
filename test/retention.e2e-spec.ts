import { SchedulerRegistry } from '@nestjs/schedule';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import * as schema from '../src/database/schema';
import { Metrics } from '../src/observability/metrics/metrics';
import { sampleOf } from '../src/observability/metrics/sample-of';
import { RetentionService } from '../src/retention/retention.service';
import { IdentityHarness } from './fixtures/identity-fixtures';

/**
 * The §7.5 retention jobs against a real Postgres.
 *
 * Every fixture sits an hour either side of the boundary it tests, and its age
 * is set with the database's own clock, the one the jobs compare against. A job
 * whose window is off by a day handles the wrong one of each pair.
 */
describe('Retention (e2e)', () => {
  let harness: IdentityHarness;
  let retention: RetentionService;
  let staffId: string;

  const eventIds: string[] = [];
  const keys: string[] = [];

  const ago = (interval: string): SQL => sql`now() - ${interval}::interval`;
  const overdue = (data: string) =>
    sampleOf(harness.app.get(Metrics), 'retention_overdue_rows', { data });

  beforeAll(async () => {
    harness = await IdentityHarness.boot();
    retention = harness.app.get(RetentionService);
    staffId = (await harness.createStaff('CASHIER')).id;

    // The hourly job would race the fixtures below.
    const scheduler = harness.app.get(SchedulerRegistry);
    await scheduler.getCronJob('retention-nightly').stop();
    await scheduler.getCronJob('retention-idempotency-keys').stop();

    // Starts every count from a clean slate, so the deltas below are exact.
    await retention.runNightly();
    await retention.runHourly();
  });

  afterAll(async () => {
    try {
      if (eventIds.length > 0) {
        await harness.db
          .delete(schema.paymentEvents)
          .where(inArray(schema.paymentEvents.providerEventId, eventIds));
      }
      if (keys.length > 0) {
        await harness.db
          .delete(schema.idempotencyKeys)
          .where(inArray(schema.idempotencyKeys.key, keys));
      }
    } finally {
      await harness.close();
    }
  });

  describe('customer names', () => {
    const givenNamedOrder = async (age: string): Promise<string> => {
      const id = uuidv7();
      await harness.db.insert(schema.orders).values({
        id,
        businessDay: '2025-01-01',
        channel: 'COUNTER',
        createdByUserId: staffId,
        status: 'COMPLETED',
        customerName: 'Somchai',
        subtotalMinor: 1000,
        vatMinor: 0,
        totalMinor: 1000,
        currency: 'THB',
        createdAt: ago(age),
      });
      return id;
    };

    const nameOf = async (id: string) =>
      (
        await harness.db.query.orders.findFirst({
          where: eq(schema.orders.id, id),
          columns: { customerName: true },
        })
      )?.customerName;

    it('clears a name past 90 days and keeps one inside them', async () => {
      const old = await givenNamedOrder('90 days 1 hour');
      const recent = await givenNamedOrder('89 days 23 hours');

      expect(await retention.clearCustomerNames()).toBe(1);

      expect(await nameOf(old)).toBeNull();
      expect(await nameOf(recent)).toBe('Somchai');
      expect(await retention.clearCustomerNames()).toBe(0);
    });
  });

  describe('webhook payloads', () => {
    // Months have different lengths, so each age is stated from the 13-month
    // boundary itself rather than as a count of days that only sometimes lands inside it.
    const PAST = sql`now() - interval '13 months' - interval '1 hour'`;
    const INSIDE = sql`now() - interval '13 months' + interval '1 hour'`;

    const givenEvent = async (receivedAt: SQL): Promise<string> => {
      const providerEventId = `evt_retention_${uuidv7()}`;
      eventIds.push(providerEventId);
      await harness.db.insert(schema.paymentEvents).values({
        providerEventId,
        eventType: 'payment_intent.succeeded',
        payload: {
          id: providerEventId,
          object: 'event',
          type: 'payment_intent.succeeded',
          created: 1_700_000_000,
          data: {
            object: {
              id: 'pi_retention',
              billing_details: { email: 'somchai@example.com' },
            },
          },
        },
        receivedAt,
      });
      return providerEventId;
    };

    const eventOf = (providerEventId: string) =>
      harness.db.query.paymentEvents.findFirst({
        where: eq(schema.paymentEvents.providerEventId, providerEventId),
      });

    it('trims a payload past 13 months down to its identifiers', async () => {
      const old = await givenEvent(PAST);

      expect(await retention.trimEventPayloads()).toBe(1);

      const row = await eventOf(old);
      expect(row?.payload).toEqual({
        id: old,
        type: 'payment_intent.succeeded',
        created: 1_700_000_000,
        data: { object: { id: 'pi_retention' } },
      });
      expect(row?.payloadTrimmedAt).not.toBeNull();
    });

    it('leaves a payload inside 13 months whole', async () => {
      const recent = await givenEvent(INSIDE);

      expect(await retention.trimEventPayloads()).toBe(0);

      expect((await eventOf(recent))?.payloadTrimmedAt).toBeNull();
    });

    // Rules out a job that re-trims every old row on every run.
    it('does not trim the same row twice', async () => {
      await givenEvent(PAST);
      await retention.trimEventPayloads();

      expect(await retention.trimEventPayloads()).toBe(0);
    });
  });

  describe('refresh tokens', () => {
    const givenToken = async (fields: {
      expiresAt: SQL;
      revokedAt?: SQL;
    }): Promise<string> => {
      const id = uuidv7();
      await harness.db.insert(schema.refreshTokens).values({
        id,
        userId: staffId,
        tokenHash: `retention-${id}`,
        familyId: uuidv7(),
        ...fields,
      });
      return id;
    };

    const exists = async (id: string) =>
      (await harness.db.query.refreshTokens.findFirst({
        where: eq(schema.refreshTokens.id, id),
      })) !== undefined;

    it('deletes tokens expired or revoked more than 30 days ago, and keeps the rest', async () => {
      const expired = await givenToken({ expiresAt: ago('30 days 1 hour') });
      const revoked = await givenToken({
        expiresAt: sql`now() + interval '1 day'`,
        revokedAt: ago('30 days 1 hour'),
      });
      const recentlyExpired = await givenToken({
        expiresAt: ago('29 days 23 hours'),
      });
      const live = await givenToken({
        expiresAt: sql`now() + interval '1 day'`,
      });

      expect(await retention.deleteStaleRefreshTokens()).toBe(2);

      expect(await exists(expired)).toBe(false);
      expect(await exists(revoked)).toBe(false);
      expect(await exists(recentlyExpired)).toBe(true);
      expect(await exists(live)).toBe(true);
    });
  });

  describe('idempotency keys', () => {
    const givenKey = async (expiresAt: SQL): Promise<string> => {
      const key = `retention-${uuidv7()}`;
      keys.push(key);
      await harness.db
        .insert(schema.idempotencyKeys)
        .values({ key, requestHash: 'hash', expiresAt });
      return key;
    };

    it('deletes a key past its expiry and keeps one that is not', async () => {
      const expired = await givenKey(ago('1 minute'));
      const live = await givenKey(sql`now() + interval '1 minute'`);

      expect(await retention.deleteExpiredIdempotencyKeys()).toBe(1);

      const left = await harness.db
        .select({ key: schema.idempotencyKeys.key })
        .from(schema.idempotencyKeys)
        .where(inArray(schema.idempotencyKeys.key, [expired, live]));
      expect(left.map((row) => row.key)).toEqual([live]);
    });
  });

  describe('the overdue gauge', () => {
    it('reads zero for everything the jobs have caught up on', async () => {
      await retention.runNightly();
      await retention.runHourly();

      for (const data of [
        'customer_names',
        'event_payloads',
        'refresh_tokens',
        'idempotency_keys',
      ]) {
        expect(await overdue(data)).toBe(0);
      }
    });

    // Within the window plus grace is the job's to do yet, not missed.
    it('counts a row only once it is past the window and the grace', async () => {
      const within = `retention-${uuidv7()}`;
      const past = `retention-${uuidv7()}`;
      keys.push(within, past);
      await harness.db.insert(schema.idempotencyKeys).values([
        {
          key: within,
          requestHash: 'hash',
          expiresAt: ago('1 hour 59 minutes'),
        },
        { key: past, requestHash: 'hash', expiresAt: ago('2 hours 1 minute') },
      ]);

      expect(await overdue('idempotency_keys')).toBe(1);

      await retention.runHourly();
      expect(await overdue('idempotency_keys')).toBe(0);
    });

    it('counts the rows each job handled', async () => {
      const metrics = harness.app.get(Metrics);
      const handled = async () =>
        (await sampleOf(metrics, 'retention_rows_total', {
          data: 'idempotency_keys',
        })) ?? 0;
      const key = `retention-${uuidv7()}`;
      keys.push(key);
      await harness.db
        .insert(schema.idempotencyKeys)
        .values({ key, requestHash: 'hash', expiresAt: ago('1 minute') });
      const before = await handled();

      await retention.runHourly();

      expect(await handled()).toBe(before + 1);
    });
  });
});
