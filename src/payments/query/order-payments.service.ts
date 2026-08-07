import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import type { Database } from '../../database/database.module';
import { DRIZZLE } from '../../database/drizzle.constants';
import { orders, payments } from '../../database/schema';
import type { PaymentMethod, PaymentStatus } from '../../database/schema/enums';
import type { Principal } from '../../identity/principal';

/**
 * One attempt, as a client may see it.
 *
 * `providerIntentId` is included and the client secret is not. The intent id is
 * a correlation handle — it is what a manager reading the Stripe Dashboard next
 * to this screen needs — while the secret authorises *confirming* the payment
 * (§10.5), so it is handed out once at creation and never stored or re-served.
 */
export interface PaymentAttemptView {
  id: string;
  status: PaymentStatus;
  method: PaymentMethod | null;
  amountMinor: number;
  currency: string;
  provider: string;
  providerIntentId: string | null;
  cashTenderedMinor: number | null;
  createdAt: string;
}

/**
 * `GET /orders/:id/payments` — the attempts behind an order (§5.2).
 *
 * A list rather than a single payment, because B4 bounds only the *live* ones:
 * a customer whose card is declined and who then pays by QR leaves two rows,
 * and the failed one is the more interesting of the two when someone is asking
 * why an order is not paid.
 */
@Injectable()
export class OrderPaymentsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listFor(
    principal: Principal,
    orderId: string,
  ): Promise<PaymentAttemptView[]> {
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: { id: true, kioskDeviceId: true },
    });
    if (order === undefined) throw new ResourceNotFoundError('order', orderId);

    /**
     * 404, not 403 — the same rule the create path applies (§6.4). A kiosk
     * learns only that it has no such order; telling it "forbidden" would
     * confirm the id exists to a token sitting in an unattended machine.
     */
    if (
      principal.type === 'device' &&
      order.kioskDeviceId !== principal.deviceId
    ) {
      throw new ResourceNotFoundError('order', orderId);
    }

    const rows = await this.db
      .select()
      .from(payments)
      .where(eq(payments.orderId, orderId))
      // Oldest first: the attempts read as the story of what the customer tried.
      .orderBy(asc(payments.createdAt));

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      method: row.method,
      amountMinor: row.amountMinor,
      currency: row.currency,
      provider: row.provider,
      providerIntentId: row.providerIntentId,
      cashTenderedMinor: row.cashTenderedMinor,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
