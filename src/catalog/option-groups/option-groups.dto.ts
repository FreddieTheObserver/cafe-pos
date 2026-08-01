import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';

const MAX_NAME_LENGTH = 60;

/**
 * An upper bound on selections, not a storage one. "Extras: 0-5" is the shape
 * §3.1 describes; a group offering fifty simultaneous picks is a data-entry
 * accident worth refusing at the edge.
 */
const MAX_SELECT = 50;

/**
 * Deltas may be negative — the schema puts no CHECK on `price_delta_minor`,
 * unlike `base_price_minor`, and "small size, -10 THB" is a real menu. Phase 3
 * owns the consequence: server-side pricing (FR-6) is what has to guarantee a
 * line total never goes below zero, since only it sees the whole basket.
 */
const MAX_PRICE_DELTA_MINOR = 100_000;

const nameField = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const selectField = z.int().min(0).max(MAX_SELECT);
const priceDeltaField = z
  .int()
  .min(-MAX_PRICE_DELTA_MINOR)
  .max(MAX_PRICE_DELTA_MINOR);

/**
 * The fallbacks here mirror the column defaults in `catalog.ts`, so a create
 * that sends only one bound is judged against the value the row will actually
 * get. If those defaults ever change, this changes with them — otherwise the
 * DB CHECK would start rejecting requests this schema called fine.
 */
const DEFAULT_MIN_SELECT = 0;
const DEFAULT_MAX_SELECT = 1;

const CreateOptionGroupSchema = z
  .strictObject({
    name: nameField,
    minSelect: selectField.optional(),
    maxSelect: selectField.optional(),
  })
  .refine(
    (body) =>
      (body.minSelect ?? DEFAULT_MIN_SELECT) <=
      (body.maxSelect ?? DEFAULT_MAX_SELECT),
    {
      message: 'minSelect must not exceed maxSelect',
      path: ['minSelect'],
    },
  );

/**
 * The bounds check only fires when the request carries both numbers. A PATCH
 * moving one of them is judged against the other as it stands in the database,
 * which only the CHECK constraint can see — `OptionGroupMinMaxInvalidError` is
 * that path's answer.
 */
const UpdateOptionGroupSchema = z
  .strictObject({
    name: nameField,
    minSelect: selectField,
    maxSelect: selectField,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'provide at least one of name, minSelect or maxSelect',
  })
  .refine(
    (body) =>
      body.minSelect === undefined ||
      body.maxSelect === undefined ||
      body.minSelect <= body.maxSelect,
    {
      message: 'minSelect must not exceed maxSelect',
      path: ['minSelect'],
    },
  );

const CreateOptionSchema = z.strictObject({
  name: nameField,
  priceDeltaMinor: priceDeltaField.optional(),
  isDefault: z.boolean().optional(),
  // Settable at creation for the same reason as an item's: staging a choice
  // before it goes on sale. Toggling it afterwards is the availability route.
  isAvailable: z.boolean().optional(),
});

/**
 * `isAvailable` is absent for the reason it is absent from `UpdateItemSchema`:
 * 86ing a choice is separately authorized (any staff member) from repricing it
 * (manager and above), and route-level guards are the only place that
 * distinction can be enforced.
 */
const UpdateOptionSchema = z
  .strictObject({
    name: nameField,
    priceDeltaMinor: priceDeltaField,
    isDefault: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'provide at least one of name, priceDeltaMinor or isDefault',
  });

const SetOptionAvailabilitySchema = z.strictObject({
  isAvailable: z.boolean(),
});

const OptionGroupIdParamSchema = z.strictObject({ id: z.uuid() });
const OptionIdParamSchema = z.strictObject({ id: z.uuid() });

export class CreateOptionGroupDto extends createZodDto(
  CreateOptionGroupSchema,
) {}
export class UpdateOptionGroupDto extends createZodDto(
  UpdateOptionGroupSchema,
) {}
export class CreateOptionDto extends createZodDto(CreateOptionSchema) {}
export class UpdateOptionDto extends createZodDto(UpdateOptionSchema) {}
export class SetOptionAvailabilityDto extends createZodDto(
  SetOptionAvailabilitySchema,
) {}
export class OptionGroupIdParamDto extends createZodDto(
  OptionGroupIdParamSchema,
) {}
export class OptionIdParamDto extends createZodDto(OptionIdParamSchema) {}
