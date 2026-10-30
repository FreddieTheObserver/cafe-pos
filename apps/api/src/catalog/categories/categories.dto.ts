import { z } from 'zod';
import { createZodDto } from '../../common/validation/zod-dto';

const MAX_NAME_LENGTH = 60;

/**
 * `sort_order` is a plain INT in the schema, so the column would take anything
 * up to 2^31. The cap here is a menu-shaped bound, not a storage one: §5.1 puts
 * the whole catalog at ≤ 200 rows, and a sort key of 90000 is a client bug
 * worth rejecting at the edge rather than storing.
 */
const MAX_SORT_ORDER = 10_000;

const nameField = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const sortOrderField = z.int().min(0).max(MAX_SORT_ORDER);

const CreateCategorySchema = z.strictObject({
  name: nameField,
  // Both optional: the table defaults them (0 / true), and a back office form
  // that only knows the name should not have to invent the rest.
  sortOrder: sortOrderField.optional(),
  isActive: z.boolean().optional(),
});

/**
 * §8 requires at least one mutable field: an empty PATCH is a client bug, and
 * answering 200 to it would hide that bug behind a success.
 */
const UpdateCategorySchema = z
  .strictObject({
    name: nameField,
    sortOrder: sortOrderField,
    isActive: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'provide at least one of name, sortOrder or isActive',
  });

const CategoryIdParamSchema = z.strictObject({ id: z.uuid() });

export class CreateCategoryDto extends createZodDto(CreateCategorySchema) {}
export class UpdateCategoryDto extends createZodDto(UpdateCategorySchema) {}
export class CategoryIdParamDto extends createZodDto(CategoryIdParamSchema) {}
