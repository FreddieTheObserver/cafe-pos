import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_IMAGE_URL_LENGTH = 2048;
const MAX_SORT_ORDER = 10_000;

/**
 * 10,000 THB in minor units. The column is a plain INT, so this is a
 * menu-shaped bound rather than a storage one: a cafe item priced above this is
 * a misplaced decimal, and catching it here beats discovering it on a receipt.
 */
const MAX_BASE_PRICE_MINOR = 1_000_000;

const nameField = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const descriptionField = z.string().trim().max(MAX_DESCRIPTION_LENGTH);
const basePriceField = z.int().min(0).max(MAX_BASE_PRICE_MINOR);
const sortOrderField = z.int().min(0).max(MAX_SORT_ORDER);

/**
 * https only, and enforced rather than assumed.
 *
 * `z.url()` accepts any scheme `new URL()` does, which includes `javascript:`
 * and `data:` — and this value is rendered by kiosk and board clients as an
 * image source. §10 puts item images on object storage behind a CDN, so there
 * is no legitimate non-https value, and the narrow rule closes a stored-XSS
 * path into an unattended tablet.
 */
const imageUrlField = z
  .string()
  .trim()
  .max(MAX_IMAGE_URL_LENGTH)
  .pipe(z.url())
  .refine((value) => value.startsWith('https://'), {
    message: 'image URL must use https',
  });

const CreateItemSchema = z.strictObject({
  categoryId: z.uuid(),
  name: nameField,
  description: descriptionField.nullable().optional(),
  basePriceMinor: basePriceField,
  imageUrl: imageUrlField.nullable().optional(),
  sortOrder: sortOrderField.optional(),
  // Settable at creation so a seasonal item can be staged before it goes on
  // sale — but *not* in the update schema below. Toggling stock is what
  // `PATCH /items/:id/availability` is for, and creating is a different act
  // from 86ing.
  isAvailable: z.boolean().optional(),
});

/**
 * §5.2 scopes this route to "price, name, photo, category" — availability is
 * deliberately absent. Keeping the toggle on its own route is what lets a
 * cashier or barista 86 an item without also holding the rights to reprice it,
 * and it leaves exactly one handler for Phase 5 to emit the FR-3 realtime
 * event from.
 */
const UpdateItemSchema = z
  .strictObject({
    categoryId: z.uuid(),
    name: nameField,
    // Nullable, so a description or photo can be cleared rather than only
    // replaced. `undefined` means "leave it"; `null` means "remove it".
    description: descriptionField.nullable(),
    basePriceMinor: basePriceField,
    imageUrl: imageUrlField.nullable(),
    sortOrder: sortOrderField,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'provide at least one mutable field',
  });

/** The 86 switch (FR-3). One field, because it is one decision. */
const SetItemAvailabilitySchema = z.strictObject({
  isAvailable: z.boolean(),
});

const ItemIdParamSchema = z.strictObject({ id: z.uuid() });

export class CreateItemDto extends createZodDto(CreateItemSchema) {}
export class UpdateItemDto extends createZodDto(UpdateItemSchema) {}
export class SetItemAvailabilityDto extends createZodDto(
  SetItemAvailabilitySchema,
) {}
export class ItemIdParamDto extends createZodDto(ItemIdParamSchema) {}
