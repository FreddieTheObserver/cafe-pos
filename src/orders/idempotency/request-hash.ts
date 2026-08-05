import { createHash } from 'node:crypto';

/**
 * Fingerprints a money-mutating request, so §5.7 can tell a genuine retry from
 * a key being reused for something else.
 *
 * Hashed from the *parsed* body rather than the raw bytes. Two clients that
 * serialise the same basket with their keys in a different order have sent the
 * same request, and refusing the second with `IDEMPOTENCY_CONFLICT` would be a
 * retry rejected for no reason. Parsing first also means defaults are already
 * applied, so omitting `optionIds` and sending `[]` agree — as they should.
 *
 * `scope` binds the fingerprint to the principal. Keys are client-generated
 * UUIDs so a collision between two tablets is not a real worry, but this means
 * a guessed key cannot be used to pull back another device's order, and it
 * costs one string.
 */
export function hashRequest(scope: string, body: unknown): string {
  return (
    createHash('sha256')
      // The length prefix is what stops a scope that ends where a body begins
      // from colliding with a different scope/body split.
      .update(`${scope.length}:${scope}`)
      .update(canonicalize(body))
      .digest('hex')
  );
}

/**
 * JSON with every object's keys in sorted order, at every depth.
 *
 * Arrays keep their order: a basket is a sequence, not a set, and two lines
 * swapped is a different receipt for a barista to read.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is not representable in JSON and a client cannot have sent
    // it; dropping it here keeps this agreeing with `JSON.stringify`.
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);

  return `{${entries.join(',')}}`;
}
