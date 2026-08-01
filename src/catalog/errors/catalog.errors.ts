import { AppException } from '../../common/errors/app.exception';

/**
 * The catalog slice of the §9.2 catalog. Codes are declared here alongside the
 * exceptions that raise them, so this object never grows an entry that no code
 * path can actually produce.
 */
export const CatalogErrorCode = {
  CATEGORY_NAME_EXISTS: 'CATEGORY_NAME_EXISTS',
  CATEGORY_UNKNOWN: 'CATEGORY_UNKNOWN',
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
