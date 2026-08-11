import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';

/** §8's ceiling on a daily range. */
export const MAX_DAY_RANGE_DAYS = 366;

/**
 * The ceiling on an hourly range.
 *
 * Hourly buckets have no stored source — `daily_sales_rollups` is one row per
 * day — so they are always aggregated off the live tables, which is §11.2's
 * first-to-break. A month answers the question anyone actually asks of hourly
 * data, with a bounded worst case of 744 buckets.
 */
export const MAX_HOUR_RANGE_DAYS = 31;

/**
 * `YYYY-MM-DD`, the shape of every `business_day` value in the schema.
 *
 * `z.iso.date()` is calendar-aware — it rejects `2026-02-30` and `2026-04-31`
 * where a bare regex would pass them through to `Date.parse`, which rolls an
 * invalid date to the next real one instead of returning `NaN`.
 */
const businessDay = z.iso.date();

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/** Inclusive day count between two business days. */
function spanInDays(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      MILLIS_PER_DAY +
    1
  );
}

export const SalesQuerySchema = z
  .object({
    from: businessDay,
    to: businessDay,
    groupBy: z.enum(['day', 'hour']).default('day'),
  })
  .refine((q) => q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine(
    (q) =>
      spanInDays(q.from, q.to) <=
      (q.groupBy === 'hour' ? MAX_HOUR_RANGE_DAYS : MAX_DAY_RANGE_DAYS),
    {
      message: `range must be at most ${MAX_DAY_RANGE_DAYS} days, or ${MAX_HOUR_RANGE_DAYS} when grouping by hour`,
      path: ['to'],
    },
  );

export class SalesQueryDto extends createZodDto(SalesQuerySchema) {}

const DEFAULT_TOP_ITEMS_LIMIT = 10;
const MAX_TOP_ITEMS_LIMIT = 50;

export const TopItemsQuerySchema = z
  .object({
    from: businessDay,
    to: businessDay,
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_TOP_ITEMS_LIMIT)
      .default(DEFAULT_TOP_ITEMS_LIMIT),
  })
  .refine((q) => q.from <= q.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine((q) => spanInDays(q.from, q.to) <= MAX_DAY_RANGE_DAYS, {
    message: `range must be at most ${MAX_DAY_RANGE_DAYS} days`,
    path: ['to'],
  });

export class TopItemsQueryDto extends createZodDto(TopItemsQuerySchema) {}

export const ZReportQuerySchema = z.object({ businessDay });

export class ZReportQueryDto extends createZodDto(ZReportQuerySchema) {}
