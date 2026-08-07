import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, isNull } from 'drizzle-orm';
import { describeError } from '../../common/errors/describe-error';
import type { Env } from '../../config/env.validation';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders, paymentEvents, payments } from '../../database/schema';
import { businessDayOf } from '../../orders/business-day';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../provider/payment-provider';

/** The §5.2 `reconciliation` block, which FR-20's Z-report will embed verbatim. */
export interface ReconciliationReport {
  businessDay: string;
  gatewayCapturedMinor: number;
  dbRecordedMinor: number;
  /** Gateway minus us. Non-zero means the books and the gateway disagree. */
  deltaMinor: number;
  /**
   * Inbox rows this system never acted on — the other direction of the same
   * question. A `REFUSE` leaves `processed_at` NULL precisely so it surfaces
   * here rather than being forgotten.
   */
  unmatchedEvents: string[];
  /** Intents we recorded as paid that the gateway does not report as captured. */
  notCaptured: string[];
}

/**
 * Nightly gateway-versus-books reconciliation (FR-20, §11.3's
 * `reconciliation_delta_minor`).
 *
 * The one job whose whole output is a number that has to be right. Everything
 * else in this module degrades on purpose — a payment method that cannot be
 * resolved is recorded as null, an unreadable inbox row is ignored — because a
 * coffee is worth more than a label. Here the opposite holds: a reconciliation
 * that cannot reach the gateway reports nothing at all rather than a delta it
 * is not sure about, because the delta's only job is to wake someone up.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * 03:00 local, which is inside §3.3's dead zone: the business day starts at
   * 05:00, so by three in the morning yesterday's trading is finished and
   * today's has not begun. Reconciling a day that is still taking money would
   * report a delta that is just work in progress.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'reconcile-yesterday',
    timeZone: 'Asia/Bangkok',
  })
  async reconcileYesterday(): Promise<ReconciliationReport | null> {
    const day = this.businessDayAt(Date.now() - 24 * 60 * 60 * 1000);

    try {
      const report = await this.reconcile(day);

      if (report.deltaMinor !== 0) {
        // §11.3 routes this to a page, not a notify: the gateway and the books
        // disagreeing about money is never something to look at on Monday.
        this.logger.error(
          `Reconciliation delta for ${day}: gateway ${report.gatewayCapturedMinor} vs books ${report.dbRecordedMinor} (delta ${report.deltaMinor}).`,
        );
      } else {
        this.logger.log(
          `Reconciled ${day}: ${report.dbRecordedMinor} minor units, delta 0.`,
        );
      }

      return report;
    } catch (error) {
      /**
       * Reported as a failed reconciliation, never as a delta of zero. "We
       * could not check" and "we checked and it agrees" are opposite facts, and
       * a job that conflates them is worse than one that does not run.
       */
      this.logger.error(
        `Could not reconcile ${day}; the books were NOT checked. ${describeError(error)}`,
      );
      return null;
    }
  }

  /** Reconciles one business day. Exposed so FR-20's Z-report can ask directly. */
  async reconcile(businessDay: string): Promise<ReconciliationReport> {
    const recorded = await this.db
      .select({
        intentId: payments.providerIntentId,
        amountMinor: payments.amountMinor,
      })
      .from(payments)
      .innerJoin(orders, eq(payments.orderId, orders.id))
      .where(
        and(
          eq(orders.businessDay, businessDay),
          eq(payments.provider, 'STRIPE'),
          // Only money we claim was captured. A failed or cancelled attempt is
          // not a disagreement with the gateway; it is one we both agree about.
          eq(payments.status, 'SUCCEEDED'),
        ),
      );

    const dbRecordedMinor = recorded.reduce(
      (total, row) => total + row.amountMinor,
      0,
    );

    const intentIds = recorded
      .map((row) => row.intentId)
      .filter((id): id is string => id !== null);

    const { totalMinor, notCaptured } =
      await this.provider.capturedTotalFor(intentIds);

    const unmatched = await this.db
      .select({ id: paymentEvents.providerEventId })
      .from(paymentEvents)
      .where(isNull(paymentEvents.processedAt));

    return {
      businessDay,
      gatewayCapturedMinor: totalMinor,
      dbRecordedMinor,
      deltaMinor: totalMinor - dbRecordedMinor,
      unmatchedEvents: unmatched.map((row) => row.id),
      notCaptured,
    };
  }

  private businessDayAt(epochMs: number): string {
    return businessDayOf(
      new Date(epochMs),
      this.config.get('BUSINESS_TIMEZONE', { infer: true }),
      this.config.get('BUSINESS_DAY_START_HOUR', { infer: true }),
    );
  }
}
