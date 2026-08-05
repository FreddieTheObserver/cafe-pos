import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '../config/env.validation';
import type { Database } from '../database/database.module';
import { DRIZZLE } from '../database/drizzle.constants';
import {
  kioskDevices,
  menuItems,
  orderItemOptions,
  orderItems,
  orderNumberCounters,
  orders,
  orderStatusHistory,
} from '../database/schema';
import type { OrderChannel, OrderStatus } from '../database/schema/enums';
import { DevicePausedError } from '../identity/errors/identity.errors';
import type { Principal } from '../identity/principal';
import { businessDayOf } from './business-day';
import {
  OrderChannelMismatchError,
  PriceMismatchError,
} from './errors/orders.errors';
import { formatOrderNumber } from './order-number';
import {
  priceOrder,
  type CatalogItem,
  type PricedOrder,
  type RequestedItem,
} from './pricing/order-pricing';

export interface CreateOrderInput {
  channel: OrderChannel;
  items: RequestedItem[];
  customerName?: string | null;
  expectedTotalMinor?: number;
}

/** An order as the API returns it (§5.3). */
export interface OrderView {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  channel: OrderChannel;
  businessDay: string;
  customerName: string | null;
  expiresAt: string | null;
  items: {
    nameSnapshot: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    notes: string | null;
    options: { group: string; name: string; priceDeltaMinor: number }[];
  }[];
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  currency: string;
}

/**
 * Order creation (FR-5, FR-6, FR-9).
 *
 * The one rule this service exists to hold: **nothing a client sends about
 * money is believed**. The body names items, options, quantities and a note;
 * every price, the queue number, the business day and the status come from
 * here. `expectedTotalMinor` is the single number the client contributes, and
 * it is used only to refuse the order (E7), never to compute one.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async create(
    principal: Principal,
    input: CreateOrderInput,
  ): Promise<OrderView> {
    const channel = await this.resolveChannel(principal, input.channel);

    const catalog = await this.readCatalog(
      input.items.map((item) => item.menuItemId),
    );
    const priced = priceOrder(
      input.items,
      catalog,
      this.config.get('VAT_BASIS_POINTS', { infer: true }),
    );

    // After pricing, so a basket that is both stale-priced and sold out hears
    // about the sold-out item first — that is the one the customer has to act
    // on, and re-pricing a basket they cannot buy is wasted taps.
    if (
      input.expectedTotalMinor !== undefined &&
      input.expectedTotalMinor !== priced.totalMinor
    ) {
      throw new PriceMismatchError(input.expectedTotalMinor, priced.totalMinor);
    }

    return this.persist(principal, channel, input, priced);
  }

  /**
   * §8's "channel matching principal type", plus the pause gate.
   *
   * Pausing is checked here rather than in the authentication guard because
   * §5.2 pauses *ordering*, not the device: a paused tablet must still read the
   * menu to render its "ordering paused" screen, and a token that stopped
   * working entirely would leave it with nothing to show.
   */
  private async resolveChannel(
    principal: Principal,
    submitted: OrderChannel,
  ): Promise<OrderChannel> {
    const expected: OrderChannel =
      principal.type === 'device' ? 'KIOSK' : 'COUNTER';
    if (submitted !== expected) {
      throw new OrderChannelMismatchError(submitted, expected);
    }

    if (principal.type === 'device') {
      const device = await this.db.query.kioskDevices.findFirst({
        where: eq(kioskDevices.id, principal.deviceId),
        columns: { status: true },
      });
      // REVOKED never reaches here — the token stops resolving at the guard.
      if (device?.status === 'PAUSED') throw new DevicePausedError();
    }

    return expected;
  }

  /**
   * The catalog rows the basket names, in the shape `priceOrder` consumes.
   *
   * Read fresh on every order rather than from the `GET /menu` cache. The cache
   * exists to make a kiosk polling every 10 seconds cheap (FR-4); an order is
   * the moment the cafe commits to a price, and a menu document that is five
   * seconds stale is exactly how an 86'd item gets sold. One query per order,
   * at six orders a minute, is not a cost worth optimising against correctness.
   *
   * An item in a deactivated category comes back marked unavailable rather than
   * missing. `is_active` on a category is a publish switch — those items are
   * absent from `GET /menu` entirely, so a basket naming one is holding a menu
   * from before the change, which is precisely the E6 story.
   */
  private async readCatalog(
    menuItemIds: string[],
  ): Promise<Map<string, CatalogItem>> {
    const rows = await this.db.query.menuItems.findMany({
      where: inArray(menuItems.id, [...new Set(menuItemIds)]),
      columns: {
        id: true,
        name: true,
        basePriceMinor: true,
        isAvailable: true,
      },
      with: {
        category: { columns: { isActive: true } },
        optionGroups: {
          columns: {},
          orderBy: (link) => [asc(link.sortOrder)],
          with: {
            optionGroup: {
              columns: {
                id: true,
                name: true,
                minSelect: true,
                maxSelect: true,
              },
              with: {
                options: {
                  columns: {
                    id: true,
                    name: true,
                    priceDeltaMinor: true,
                    isAvailable: true,
                  },
                  orderBy: (option) => [asc(option.name)],
                },
              },
            },
          },
        },
      },
    });

    return new Map(
      rows.map((item) => [
        item.id,
        {
          id: item.id,
          name: item.name,
          basePriceMinor: item.basePriceMinor,
          isAvailable: item.isAvailable && item.category.isActive,
          optionGroups: item.optionGroups.map((link) => link.optionGroup),
        },
      ]),
    );
  }

  /**
   * Order, lines, option snapshots and the opening history row, in one
   * transaction — the §4.3 Order aggregate boundary. A crash between any two of
   * these statements leaves no order at all, which is the only acceptable
   * outcome: a half-written order with a queue number is one a barista would
   * eventually be handed.
   */
  private async persist(
    principal: Principal,
    channel: OrderChannel,
    input: CreateOrderInput,
    priced: PricedOrder,
  ): Promise<OrderView> {
    const now = new Date();
    const businessDay = businessDayOf(
      now,
      this.config.get('BUSINESS_TIMEZONE', { infer: true }),
      this.config.get('BUSINESS_DAY_START_HOUR', { infer: true }),
    );

    /**
     * Straight to PENDING_PAYMENT. DRAFT is the counter's "park this while the
     * customer decides" and arrives with `POST /orders/:id/checkout`; creating
     * one here would spend a queue number on a basket nobody has committed to.
     */
    const status: OrderStatus = 'PENDING_PAYMENT';
    const expiresAt = new Date(
      now.getTime() +
        this.config.get('ORDER_EXPIRY_SECONDS', { infer: true }) * 1000,
    );

    return this.db.transaction(async (tx) => {
      const sequence = await nextOrderNumber(tx, businessDay);

      const [order] = await tx
        .insert(orders)
        .values({
          orderNumber: formatOrderNumber(sequence),
          businessDay,
          channel,
          status,
          kioskDeviceId:
            principal.type === 'device' ? principal.deviceId : null,
          createdByUserId: principal.type === 'staff' ? principal.userId : null,
          customerName: input.customerName ?? null,
          subtotalMinor: priced.subtotalMinor,
          vatMinor: priced.vatMinor,
          totalMinor: priced.totalMinor,
          currency: this.config.get('CURRENCY', { infer: true }),
          expiresAt,
        })
        .returning();

      // One insert per level rather than per line: a 30-line order is two
      // round trips, not sixty.
      const lines = await tx
        .insert(orderItems)
        .values(
          priced.lines.map((line) => ({
            orderId: order.id,
            menuItemId: line.menuItemId,
            nameSnapshot: line.nameSnapshot,
            unitPriceMinorSnapshot: line.unitPriceMinorSnapshot,
            quantity: line.quantity,
            lineTotalMinor: line.lineTotalMinor,
            notes: line.notes,
          })),
        )
        .returning({ id: orderItems.id });

      const optionRows = priced.lines.flatMap((line, index) =>
        line.options.map((option) => ({
          orderItemId: lines[index].id,
          optionId: option.optionId,
          groupNameSnapshot: option.groupNameSnapshot,
          optionNameSnapshot: option.optionNameSnapshot,
          priceDeltaMinorSnapshot: option.priceDeltaMinorSnapshot,
        })),
      );
      if (optionRows.length > 0) {
        await tx.insert(orderItemOptions).values(optionRows);
      }

      /**
       * The order's first line in the audit trail (FR-22). `fromStatus` is null
       * because there was no previous state — the row records a creation, not a
       * transition, and inventing a "from" would make the history lie about how
       * the order began.
       */
      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        fromStatus: null,
        toStatus: status,
        actorType: principal.type === 'device' ? 'DEVICE' : 'USER',
        actorId:
          principal.type === 'device' ? principal.deviceId : principal.userId,
      });

      return toView(order, priced);
    });
  }
}

/**
 * Allocates the next queue number for a business day (B3).
 *
 * One statement, and an upsert rather than a read-then-write because two kiosks
 * checking out in the same second is the normal case at peak, not an edge one.
 * `ON CONFLICT DO UPDATE` makes the counter row's own lock the serialization
 * point: the losing transaction waits for the winner to commit and then reads
 * the incremented value. No duplicates, and no application-level lock to get
 * wrong.
 *
 * A counter table rather than a Postgres sequence, and that is the whole reason
 * it exists. A sequence is deliberately non-transactional — it would keep
 * counting through a rolled-back checkout and leave A-041 permanently missing.
 * This increment rolls back with the order it was for, which is what makes B3's
 * "unique per business day" also gapless.
 *
 * The cost is real and bounded: because the lock is taken here and released at
 * commit, checkouts on the same business day serialize across the four
 * statements that follow. At §3.5's peak of ~6 orders a minute that is nothing,
 * and it is the reason those statements are kept to four.
 */
async function nextOrderNumber(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  businessDay: string,
): Promise<number> {
  const [counter] = await tx
    .insert(orderNumberCounters)
    .values({ businessDay, lastValue: 1 })
    .onConflictDoUpdate({
      target: orderNumberCounters.businessDay,
      set: { lastValue: sql`${orderNumberCounters.lastValue} + 1` },
    })
    .returning({ lastValue: orderNumberCounters.lastValue });

  return counter.lastValue;
}

function toView(
  order: typeof orders.$inferSelect,
  priced: PricedOrder,
): OrderView {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    channel: order.channel,
    businessDay: order.businessDay,
    customerName: order.customerName,
    expiresAt: order.expiresAt?.toISOString() ?? null,
    items: priced.lines.map((line) => ({
      nameSnapshot: line.nameSnapshot,
      unitPriceMinor: line.unitPriceMinorSnapshot,
      quantity: line.quantity,
      lineTotalMinor: line.lineTotalMinor,
      notes: line.notes,
      options: line.options.map((option) => ({
        group: option.groupNameSnapshot,
        name: option.optionNameSnapshot,
        priceDeltaMinor: option.priceDeltaMinorSnapshot,
      })),
    })),
    subtotalMinor: order.subtotalMinor,
    vatMinor: order.vatMinor,
    totalMinor: order.totalMinor,
    currency: order.currency,
  };
}
