import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { describeError } from '../common/errors/describe-error';
import type { Database } from '../database/database.module';
import { DRIZZLE } from '../database/drizzle.constants';
import {
  idempotencyKeys,
  orders,
  paymentEvents,
  refreshTokens,
} from '../database/schema';
import { Metrics } from '../observability/metrics/metrics';
import { drainInBatches } from './drain-in-batches';
import {
  RETAINED_DATA,
  RETENTION,
  type RetainedData,
} from './retention-policy';

const BATCH_SIZE = 1000;

const cutoff = (data: RetainedData) =>
  sql`now() - ${RETENTION[data].window}::interval`;

const overdueCutoff = (data: RetainedData) =>
  sql`now() - (${RETENTION[data].window}::interval + ${RETENTION[data].grace}::interval)`;

/**
 * The §7.5 retention jobs.
 *
 * Each is a single guarded statement run in batches: the `WHERE` clause is the
 * whole policy, so a second run, or both instances running at once, finds
 * nothing left to do. Whether they are keeping up is read from the data itself
 * by `retention_overdue_rows`, which survives restarts in a way a "last run"
 * timestamp in memory would not.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly metrics: Metrics,
  ) {
    metrics.scraped(
      {
        name: 'retention_overdue_rows',
        help: 'Rows past their retention window plus the grace their job is allowed, by kind of data.',
        labelNames: ['data'] as const,
      },
      async () => {
        const counts = await this.overdueCounts();
        return RETAINED_DATA.map((data) => ({
          labels: { data },
          value: counts[data],
        }));
      },
    );
  }

  // 04:00 sits in the dead zone after the 03:00 rollup and reconciliation and
  // before the 05:00 business-day boundary.
  @Cron('0 0 4 * * *', { name: 'retention-nightly', timeZone: 'Asia/Bangkok' })
  async runNightly(): Promise<void> {
    await this.run('customer_names', () => this.clearCustomerNames());
    await this.run('event_payloads', () => this.trimEventPayloads());
    await this.run('refresh_tokens', () => this.deleteStaleRefreshTokens());
  }

  // Hourly, so the 24-hour window is met within the hour.
  @Cron('0 17 * * * *', { name: 'retention-idempotency-keys' })
  async runHourly(): Promise<void> {
    await this.run('idempotency_keys', () =>
      this.deleteExpiredIdempotencyKeys(),
    );
  }

  /** PDPA minimisation: reports never use names (§7.5). */
  clearCustomerNames(): Promise<number> {
    return drainInBatches(
      async (limit) =>
        (
          await this.db
            .update(orders)
            .set({ customerName: null })
            .where(
              inArray(
                orders.id,
                this.db
                  .select({ id: orders.id })
                  .from(orders)
                  .where(
                    and(
                      isNotNull(orders.customerName),
                      lt(orders.createdAt, cutoff('customer_names')),
                    ),
                  )
                  .limit(limit),
              ),
            )
            .returning({ id: orders.id })
        ).length,
      { batchSize: BATCH_SIZE },
    );
  }

  /**
   * Cuts a gateway payload, which can carry cardholder and billing details, down
   * to what identifies the event. The row stays: it is the audit trail.
   */
  trimEventPayloads(): Promise<number> {
    const payload = paymentEvents.payload;
    return drainInBatches(
      async (limit) =>
        (
          await this.db
            .update(paymentEvents)
            .set({
              payload: sql`jsonb_build_object(
                'id', ${payload}->'id',
                'type', ${payload}->'type',
                'created', ${payload}->'created',
                'data', jsonb_build_object('object', jsonb_build_object('id', ${payload}->'data'->'object'->'id'))
              )`,
              payloadTrimmedAt: sql`now()`,
            })
            .where(
              inArray(
                paymentEvents.id,
                this.db
                  .select({ id: paymentEvents.id })
                  .from(paymentEvents)
                  .where(
                    and(
                      isNull(paymentEvents.payloadTrimmedAt),
                      lt(paymentEvents.receivedAt, cutoff('event_payloads')),
                    ),
                  )
                  .limit(limit),
              ),
            )
            .returning({ id: paymentEvents.id })
        ).length,
      { batchSize: BATCH_SIZE },
    );
  }

  deleteStaleRefreshTokens(): Promise<number> {
    return drainInBatches(
      async (limit) =>
        (
          await this.db
            .delete(refreshTokens)
            .where(
              inArray(
                refreshTokens.id,
                this.db
                  .select({ id: refreshTokens.id })
                  .from(refreshTokens)
                  .where(
                    or(
                      lt(refreshTokens.expiresAt, cutoff('refresh_tokens')),
                      lt(refreshTokens.revokedAt, cutoff('refresh_tokens')),
                    ),
                  )
                  .limit(limit),
              ),
            )
            .returning({ id: refreshTokens.id })
        ).length,
      { batchSize: BATCH_SIZE },
    );
  }

  deleteExpiredIdempotencyKeys(): Promise<number> {
    return drainInBatches(
      async (limit) =>
        (
          await this.db
            .delete(idempotencyKeys)
            .where(
              inArray(
                idempotencyKeys.key,
                this.db
                  .select({ key: idempotencyKeys.key })
                  .from(idempotencyKeys)
                  .where(
                    lt(idempotencyKeys.expiresAt, cutoff('idempotency_keys')),
                  )
                  .limit(limit),
              ),
            )
            .returning({ key: idempotencyKeys.key })
        ).length,
      { batchSize: BATCH_SIZE },
    );
  }

  private async run(
    data: RetainedData,
    job: () => Promise<number>,
  ): Promise<void> {
    try {
      const handled = await job();
      this.metrics.retentionRows.inc({ data }, handled);
      if (handled > 0) this.logger.log(`Retention: ${data}, ${handled} rows.`);
    } catch (error) {
      // Not rethrown: one job failing must not stop the next. The overdue
      // gauge is what notices if it keeps failing.
      this.logger.error(
        `Retention job for ${data} failed. ${describeError(error)}`,
      );
    }
  }

  private async overdueCounts(): Promise<Record<RetainedData, number>> {
    const {
      rows: [row],
    } = await this.db.execute<Record<RetainedData, number>>(sql`
      select
        (select count(*) from ${orders}
          where ${orders.customerName} is not null
            and ${orders.createdAt} < ${overdueCutoff('customer_names')})::int as customer_names,
        (select count(*) from ${paymentEvents}
          where ${paymentEvents.payloadTrimmedAt} is null
            and ${paymentEvents.receivedAt} < ${overdueCutoff('event_payloads')})::int as event_payloads,
        (select count(*) from ${refreshTokens}
          where ${refreshTokens.expiresAt} < ${overdueCutoff('refresh_tokens')}
             or ${refreshTokens.revokedAt} < ${overdueCutoff('refresh_tokens')})::int as refresh_tokens,
        (select count(*) from ${idempotencyKeys}
          where ${idempotencyKeys.expiresAt} < ${overdueCutoff('idempotency_keys')})::int as idempotency_keys
    `);
    return row;
  }
}
