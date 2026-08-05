import { z } from 'zod';
import { createZodDto } from '../common/validation/zod-dto';
import { orderChannels, orderStatuses } from '../database/schema/enums';

/**
 * The §8 bounds for `POST /orders`, and each of them is load-bearing.
 *
 * A kiosk basket is a public, unauthenticated shape in every way that matters —
 * the device token says which tablet, never which customer — so these caps are
 * what stops one tap from asking the server to price ten thousand lines. They
 * are menu-shaped rather than storage-shaped: a cafe order of 31 distinct items
 * is a stuck button, not a customer.
 */
const MAX_ITEMS_PER_ORDER = 30;
const MAX_QUANTITY_PER_ITEM = 50;
const MAX_OPTIONS_PER_ITEM = 15;
const MAX_NOTES_LENGTH = 140;
const MAX_CUSTOMER_NAME_LENGTH = 40;

/**
 * 100,000 THB in minor units. Only ever compared against a server-computed
 * total, never stored — the bound exists so a client cannot make the comparison
 * itself expensive or the echoed `meta` absurd.
 */
const MAX_EXPECTED_TOTAL_MINOR = 10_000_000;

/**
 * Stored verbatim, capped, never sanitized on the way in (§8, §10.3).
 * Escaping is the renderer's job; mangling a customer's note here would put
 * "less &amp; sweet" on a barista's screen.
 */
const notesField = z.string().trim().max(MAX_NOTES_LENGTH);

const OrderItemSchema = z.strictObject({
  menuItemId: z.uuid(),
  quantity: z.int().min(1).max(MAX_QUANTITY_PER_ITEM),
  /**
   * A flat list, not a map keyed by group: the client sends what the customer
   * tapped and the server decides which group each option belongs to. Letting
   * the client assert the grouping would mean trusting it about the shape of
   * the menu, which is the thing FR-6 exists to stop.
   */
  optionIds: z.array(z.uuid()).max(MAX_OPTIONS_PER_ITEM).default([]),
  notes: notesField.nullable().optional(),
});

const CreateOrderSchema = z.strictObject({
  /**
   * Redundant with the credential and checked against it anyway (§8: "enum
   * matching principal type"). A device token can only produce a KIOSK order
   * and a staff token only a COUNTER one, so this field never *decides*
   * anything — it catches a client that thinks it is something it is not,
   * before the mistake reaches the channel split in every report.
   */
  channel: z.enum(orderChannels),
  items: z.array(OrderItemSchema).min(1).max(MAX_ITEMS_PER_ORDER),
  /**
   * The only customer PII the system holds (§3.3), and optional even here.
   * Purged after 90 days by the §7.5 retention job.
   */
  customerName: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CUSTOMER_NAME_LENGTH)
    .nullable()
    .optional(),
  /**
   * What the kiosk showed the customer (E7). Optional: a cashier reading prices
   * off the screen they just edited has no stale total to guard against, while
   * a kiosk holding a cached menu very much does. Sending it is what buys the
   * "never charged a number they did not see" guarantee.
   */
  expectedTotalMinor: z.int().min(0).max(MAX_EXPECTED_TOTAL_MINOR).optional(),
});

const OrderIdParamSchema = z.strictObject({ id: z.uuid() });

/**
 * `to` accepts the whole enum, and legality is decided by the service (§8).
 *
 * Narrowing this to the three transitions the route exposes would be tidier and
 * wrong: §8 puts transition legality in the *business* layer, so asking for a
 * move that is real but not yours must answer `409 ORDER_INVALID_TRANSITION`
 * carrying the order's current status — not a 422 about a field.
 */
const TransitionOrderSchema = z.strictObject({
  to: z.enum(orderStatuses),
});

/** §8 caps the cancellation reason at 200; it lands on the history row. */
const CancelOrderSchema = z.strictObject({
  reason: z.string().trim().min(1).max(200).nullable().optional(),
});

export class CreateOrderDto extends createZodDto(CreateOrderSchema) {}
export class OrderIdParamDto extends createZodDto(OrderIdParamSchema) {}
export class TransitionOrderDto extends createZodDto(TransitionOrderSchema) {}
export class CancelOrderDto extends createZodDto(CancelOrderSchema) {}
