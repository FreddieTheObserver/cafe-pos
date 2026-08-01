import { AppException } from '../../common/errors/app.exception';

/**
 * The catalog slice of the §9.2 catalog. Codes are declared here alongside the
 * exceptions that raise them, so this object never grows an entry that no code
 * path can actually produce.
 */
export const CatalogErrorCode = {
  CATEGORY_NAME_EXISTS: 'CATEGORY_NAME_EXISTS',
  CATEGORY_UNKNOWN: 'CATEGORY_UNKNOWN',
  OPTION_GROUP_MINMAX_INVALID: 'OPTION_GROUP_MINMAX_INVALID',
  OPTION_GROUP_UNKNOWN: 'OPTION_GROUP_UNKNOWN',
} as const;

/**
 * `POST /categories` or a rename against a name already taken (§5.2).
 *
 * 409 rather than 422: the request is well-formed, the world just already
 * contains the thing it asks to create.
 */
export class CategoryNameExistsError extends AppException {
  constructor(name: string) {
    super({
      code: CatalogErrorCode.CATEGORY_NAME_EXISTS,
      status: 409,
      title: 'Category name taken',
      detail: 'A category with that name already exists.',
      // Echoing back what the caller just sent costs nothing and lets a back
      // office form mark the offending field.
      meta: { name },
    });
  }
}

/**
 * An item filed under a category id that does not exist (§5.2).
 *
 * 422, not 404: the missing thing is a value *inside* a well-formed request,
 * not the resource the URL addresses. A 404 here would tell a back office form
 * that `/items` does not exist, which is both wrong and unactionable. This
 * mirrors the shape §5.2 gives `OPTION_GROUP_UNKNOWN` for the same mistake one
 * level down.
 */
export class CategoryUnknownError extends AppException {
  constructor(categoryId: string) {
    super({
      code: CatalogErrorCode.CATEGORY_UNKNOWN,
      status: 422,
      title: 'Unknown category',
      detail: 'No category with that id exists.',
      meta: { categoryId },
    });
  }
}

/**
 * Selection bounds that cannot be satisfied — `minSelect` above `maxSelect`
 * (§5.2).
 *
 * The DTOs reject this at the edge whenever the request carries both numbers.
 * This exists for the case validation structurally cannot see: a PATCH that
 * lowers `maxSelect` below a `minSelect` already in the database. The CHECK
 * constraint catches it, and this turns that into the documented 422 instead
 * of an unhandled driver error.
 */
export class OptionGroupMinMaxInvalidError extends AppException {
  constructor() {
    super({
      code: CatalogErrorCode.OPTION_GROUP_MINMAX_INVALID,
      status: 422,
      title: 'Invalid selection bounds',
      detail:
        'An option group needs 0 <= minSelect <= maxSelect; this change would leave bounds nothing can satisfy.',
    });
  }
}

/**
 * `PUT /items/:id/option-groups` naming groups that do not exist (§5.2).
 *
 * 422 rather than 404 for the same reason as `CATEGORY_UNKNOWN`: the missing
 * things are values inside the body, not the item the URL addresses. All of
 * the unknown ids are reported at once — a back office attaching five groups
 * should not have to fix them one round trip at a time.
 */
export class OptionGroupUnknownError extends AppException {
  constructor(optionGroupIds: string[]) {
    super({
      code: CatalogErrorCode.OPTION_GROUP_UNKNOWN,
      status: 422,
      title: 'Unknown option group',
      detail: 'No option group exists for one or more of the ids provided.',
      meta: { optionGroupIds },
    });
  }
}
