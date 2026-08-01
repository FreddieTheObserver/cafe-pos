import { AppException } from '../../common/errors/app.exception';

/**
 * The catalog slice of the §9.2 catalog. Codes are declared here alongside the
 * exceptions that raise them, so this object never grows an entry that no code
 * path can actually produce.
 */
export const CatalogErrorCode = {
  CATEGORY_NAME_EXISTS: 'CATEGORY_NAME_EXISTS',
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
