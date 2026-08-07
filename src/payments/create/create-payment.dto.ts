import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';
import { paymentMethods } from '../../database/schema/enums';

/**
 * §8's row for `POST /orders/:id/payments`.
 *
 * The tender rules are split on purpose. "CASH without a tender is malformed"
 * is a property of the body alone and belongs here, as a 422 the client can fix
 * by resending. "The tender covers the total" needs the order, so it lives in
 * the service — a 409 about state, not shape.
 */
const CreatePaymentSchema = z
  .strictObject({
    method: z.enum(paymentMethods),
    cashTenderedMinor: z.int().positive().optional(),
  })
  .refine(
    (body) => body.method !== 'CASH' || body.cashTenderedMinor !== undefined,
    {
      message: 'cashTenderedMinor is required for a CASH payment',
      path: ['cashTenderedMinor'],
    },
  )
  /**
   * A tender against a gateway payment is a client bug worth naming. Ignoring
   * it silently would let a till that believes it is taking cash open a card
   * intent instead, with nothing saying so until reconciliation.
   */
  .refine(
    (body) => body.method === 'CASH' || body.cashTenderedMinor === undefined,
    {
      message: 'cashTenderedMinor is only valid for a CASH payment',
      path: ['cashTenderedMinor'],
    },
  );

export class CreatePaymentDto extends createZodDto(CreatePaymentSchema) {}
