import { AppException } from '../../common/errors/app.exception';
import { parseIdempotencyKey } from './idempotency-key';

describe('parseIdempotencyKey', () => {
  it('accepts the UUID §5.7 tells clients to generate', () => {
    const key = '0197f3aa-8e1c-7c3a-9f2b-2a1d4c6e8f01';

    expect(parseIdempotencyKey(key)).toBe(key);
  });

  // Not narrowed to UUIDs: the value is only ever a primary key, and refusing a
  // client that generates a perfectly good ULID would buy nothing.
  it('accepts other opaque token formats', () => {
    expect(parseIdempotencyKey('01HQ3T5VJ8ZK9M2N4P6R8S0T2V')).toBe(
      '01HQ3T5VJ8ZK9M2N4P6R8S0T2V',
    );
  });

  it('treats an absent header as no key at all', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  /**
   * An empty or whitespace header is a client bug worth surfacing, not a key.
   * Reading it as "no key" would silently drop the protection the client
   * believes it has, which is the worst of the three options.
   */
  it('refuses an empty header rather than ignoring it', () => {
    expect(() => parseIdempotencyKey('')).toThrow(AppException);
    expect(() => parseIdempotencyKey('   ')).toThrow(AppException);
  });

  it('refuses a key too short to be unguessable', () => {
    expect(() => parseIdempotencyKey('abc')).toThrow(AppException);
  });

  it('refuses a key long enough to bloat the index', () => {
    expect(() => parseIdempotencyKey('a'.repeat(129))).toThrow(AppException);
  });

  // The value reaches a primary key and an error message; keeping it to token
  // characters means it can never carry a newline into either.
  it('refuses characters outside the token alphabet', () => {
    expect(() => parseIdempotencyKey('key with spaces')).toThrow(AppException);
    expect(() => parseIdempotencyKey('key\nwith-newline')).toThrow(
      AppException,
    );
    expect(() => parseIdempotencyKey('key/with/slashes')).toThrow(AppException);
  });

  it('refuses with a 422 naming the header', () => {
    try {
      parseIdempotencyKey('!!');
      fail('expected a validation error');
    } catch (error) {
      const problem = error as AppException;
      expect(problem.status).toBe(422);
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.[0].field).toBe('Idempotency-Key');
    }
  });
});
