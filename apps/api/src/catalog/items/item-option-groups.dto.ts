import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';

/**
 * A drink with more than this many decisions in front of it is a kiosk screen
 * nobody finishes. The bound is a UX judgement, not a storage limit.
 */
const MAX_GROUPS_PER_ITEM = 20;

/**
 * Order is the array's own order, rather than an explicit `sortOrder` per
 * entry.
 *
 * A list cannot express a duplicate rank or a gap, so the whole class of "two
 * groups both claim position 3" disappears instead of needing a rule. It also
 * makes the request read the way the kiosk renders it: top to bottom.
 */
const SetItemOptionGroupsSchema = z.strictObject({
  optionGroupIds: z
    .array(z.uuid())
    .max(MAX_GROUPS_PER_ITEM)
    .refine((ids) => new Set(ids).size === ids.length, {
      // The join table's composite PK would reject this anyway; saying so here
      // names the field instead of surfacing a constraint name.
      message: 'option group ids must not repeat',
    }),
});

export class SetItemOptionGroupsDto extends createZodDto(
  SetItemOptionGroupsSchema,
) {}
