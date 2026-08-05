import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The row a page resumes after: one sort value plus the id that breaks ties. */
export interface Cursor {
  value: string;
  id: string;
}

/**
 * Encodes the last row of a page (§5.1).
 *
 * Base64url of a tiny JSON object rather than a signed token: the payload is a
 * timestamp and an id the caller has already been shown, so there is nothing
 * here worth protecting. "Opaque" in §5.1 means the client is told not to parse
 * it, not that it could not.
 *
 * The sort spec travels with it, so a client that pages by date and then
 * switches to price cannot carry a stale cursor across — the comparison would
 * be against a different column and would silently return the wrong window.
 */
export function encodeCursor(sort: string, value: string, id: string): string {
  return Buffer.from(JSON.stringify({ s: sort, v: value, i: id })).toString(
    'base64url',
  );
}

export function decodeCursor(raw: string, sort: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    // Anything a client can put in a query string ends up here; the shape check
    // below is what actually decides, so this only has to not throw raw.
    throw new CursorInvalidError();
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new CursorInvalidError();
  }

  const { s, v, i } = parsed as Record<string, unknown>;
  if (typeof s !== 'string' || typeof v !== 'string' || typeof i !== 'string') {
    throw new CursorInvalidError();
  }
  if (s !== sort) throw new CursorInvalidError();
  // The id goes into a row-value comparison against a uuid column; a
  // non-uuid would be a cast error from the driver rather than a 422.
  if (!UUID_PATTERN.test(i)) throw new CursorInvalidError();

  return { value: v, id: i };
}

/**
 * Reuses `VALIDATION_FAILED` rather than inventing a code (§9.2 is the
 * published contract). A client that mangled a cursor has one recovery — drop
 * it and ask for the first page again — so the detail says exactly that.
 */
class CursorInvalidError extends AppException {
  constructor() {
    super({
      code: ErrorCode.VALIDATION_FAILED,
      status: 422,
      title: 'Invalid cursor',
      detail:
        'That cursor is not one this endpoint issued for this sort. Request the first page without a cursor.',
      errors: [
        {
          field: 'cursor',
          rule: 'format',
          message: 'must be a cursor returned by this endpoint for this sort',
        },
      ],
    });
  }
}
