import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';

/** §8's row for `POST /payments/:id/refunds`. */
const CreateRefundSchema = z.strictObject({
  amountMinor: z.int().positive(),
  /**
   * Required, unlike a cancellation's optional one. A refund is the only place
   * money leaves the till, and §8 asks for a reason because the Z-report and
   * any later dispute are read by someone who was not standing there.
   */
  reason: z.string().trim().min(1).max(200),
});

const PaymentIdParamSchema = z.strictObject({ id: z.uuid() });

export class CreateRefundDto extends createZodDto(CreateRefundSchema) {}
export class PaymentIdParamDto extends createZodDto(PaymentIdParamSchema) {}
