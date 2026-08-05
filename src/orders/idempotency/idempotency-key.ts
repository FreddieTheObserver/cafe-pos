import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * Long enough that two clients cannot collide by accident, short enough that
 * the primary key stays small. §5.7 tells clients to send a UUID; the rule is
 * deliberately wider than that, because the value is only ever used as a key
 * and refusing a client that generates a perfectly good ULID would buy nothing.
 */
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

/** Token characters only — this value reaches a primary key and an error body. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Validates the `Idempotency-Key` header, if one was sent.
 *
 * A malformed header is refused rather than ignored. Reading it as "no key"
 * would silently drop the protection the client believes it has — the client
 * would retry a timed-out order expecting a replay and get a second one — and
 * that is a worse failure than a 422 it can see in testing.
 */
export function parseIdempotencyKey(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;

  const key = raw.trim();
  if (
    key.length < MIN_LENGTH ||
    key.length > MAX_LENGTH ||
    !KEY_PATTERN.test(key)
  ) {
    throw new IdempotencyKeyInvalidError();
  }

  return key;
}

/**
 * Reuses `VALIDATION_FAILED` rather than inventing a code: §9.2 is the
 * published contract and this is a field-level shape complaint, which is what
 * 422's `errors[]` is for. The field names the header so a client knows where
 * to look — the validation pipe cannot report it, since headers never reach it.
 */
class IdempotencyKeyInvalidError extends AppException {
  constructor() {
    super({
      code: ErrorCode.VALIDATION_FAILED,
      status: 422,
      title: 'Invalid idempotency key',
      detail: `Idempotency-Key must be ${MIN_LENGTH}-${MAX_LENGTH} characters of letters, digits, and ".", "_", ":" or "-".`,
      errors: [
        {
          field: 'Idempotency-Key',
          rule: 'format',
          message: 'must be an opaque token, ideally a UUID',
        },
      ],
    });
  }
}
