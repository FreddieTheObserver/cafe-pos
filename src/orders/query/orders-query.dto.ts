import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';
import { orderChannels, orderStatuses } from '../../database/schema/enums';

/**
 * §5.1's sort whitelist. Arbitrary column sorting is refused rather than
 * mapped: it is both an injection surface and a licence to ask for an
 * unindexed sort over every order the cafe has ever taken.
 */
export const orderSorts = [
  '-createdAt',
  'createdAt',
  '-totalMinor',
  'totalMinor',
] as const;
export type OrderSort = (typeof orderSorts)[number];

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * §8's ceiling on a single request's date range. An unbounded range over a
 * cursor-paginated list is not dangerous so much as useless — it is a report,
 * and reports have their own endpoints (§5.2) built on aggregates rather than
 * on paging through every row.
 */
const MAX_RANGE_DAYS = 92;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

const MAX_SEARCH_LENGTH = 40;

/**
 * Query strings arrive as strings or, when a key repeats, as arrays. Only the
 * comma-separated form is supported (§5.1), so a repeated key is a client
 * error rather than something to quietly concatenate.
 */
const commaSeparated = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((raw) => raw.split(',').map((value) => value.trim()))
    .pipe(z.array(z.enum(values)).min(1))
    // A list is a set of alternatives; the same status twice is the same query.
    .transform((values) => [...new Set(values)]);

const OrdersQuerySchema = z
  .strictObject({
    status: commaSeparated(orderStatuses).optional(),
    channel: commaSeparated(orderChannels).optional(),
    /** ISO-8601 instants on `created_at` (§5.1). */
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    /**
     * The reporting-friendly alternative to a `from`/`to` pair, and not the
     * same question: a business day is the cafe's day (B7), which is not the
     * span between two midnights.
     */
    businessDay: z.iso.date().optional(),
    /** Exact order number, or a customer-name prefix (§5.6). */
    q: z.string().trim().min(1).max(MAX_SEARCH_LENGTH).optional(),
    sort: z.enum(orderSorts).default('-createdAt'),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    cursor: z.string().min(1).optional(),
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      Date.parse(query.from) <= Date.parse(query.to),
    { message: 'from must not be after to', path: ['from'] },
  )
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      Date.parse(query.to) - Date.parse(query.from) <= MAX_RANGE_MS,
    {
      message: `range must not exceed ${MAX_RANGE_DAYS} days`,
      path: ['to'],
    },
  )
  /**
   * A half-open range would silently become "everything up to here", which is
   * the unbounded scan the ceiling above exists to prevent. Requiring the pair
   * makes the client state the window it means.
   */
  .refine((query) => (query.from === undefined) === (query.to === undefined), {
    message: 'from and to must be given together',
    path: ['from'],
  });

export class OrdersQueryDto extends createZodDto(OrdersQuerySchema) {}
