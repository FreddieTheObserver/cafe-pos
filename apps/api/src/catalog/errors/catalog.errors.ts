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
  IMAGE_FILE_MISSING: 'IMAGE_FILE_MISSING',
  IMAGE_TYPE_UNSUPPORTED: 'IMAGE_TYPE_UNSUPPORTED',
  IMAGE_UNPROCESSABLE: 'IMAGE_UNPROCESSABLE',
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

/** An image upload with no `file` part — a malformed form, not a bad image. */
export class ImageFileMissingError extends AppException {
  constructor() {
    super({
      code: CatalogErrorCode.IMAGE_FILE_MISSING,
      status: 422,
      title: 'No file uploaded',
      detail: 'Send the image as a multipart form field named "file".',
    });
  }
}

/**
 * Upload whose bytes are not one of the accepted image formats (§10).
 *
 * 415 rather than 422: the request is well-formed and the field is present —
 * the *media type* is the thing being refused, which is exactly what 415 is
 * for. Never echoes the submitted type or filename: both are attacker-chosen
 * strings that end up in logs and in a back office toast.
 */
export class ImageTypeUnsupportedError extends AppException {
  constructor(accepted: readonly string[]) {
    super({
      code: CatalogErrorCode.IMAGE_TYPE_UNSUPPORTED,
      status: 415,
      title: 'Unsupported image type',
      detail: 'That file is not an accepted image format.',
      meta: { accepted: [...accepted] },
    });
  }
}

/**
 * The bytes claim an accepted format but the decoder refused them — truncated,
 * corrupt, or a decompression bomb over the pixel ceiling.
 *
 * Kept distinct from the type error so a back office can tell "wrong kind of
 * file" from "this JPEG is broken", which are different things for a user to
 * fix. The decoder's own message is deliberately not forwarded: it names
 * internals and is derived from hostile input.
 */
export class ImageUnprocessableError extends AppException {
  constructor() {
    super({
      code: CatalogErrorCode.IMAGE_UNPROCESSABLE,
      status: 422,
      title: 'Image could not be processed',
      detail: 'That image could not be read. It may be corrupt or too large.',
    });
  }
}
