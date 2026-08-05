import { AppException } from '../../common/errors/app.exception';
import { decodeCursor, encodeCursor } from './cursor';

const SORT = '-createdAt';
const ID = '0197f3aa-8e1c-7c3a-9f2b-2a1d4c6e8f01';

describe('order list cursor', () => {
  it('round-trips the row it points at', () => {
    const cursor = encodeCursor(SORT, '2026-06-11T07:32:10.000Z', ID);

    expect(decodeCursor(cursor, SORT)).toEqual({
      value: '2026-06-11T07:32:10.000Z',
      id: ID,
    });
  });

  it('round-trips a numeric sort value', () => {
    const cursor = encodeCursor('totalMinor', '17500', ID);

    expect(decodeCursor(cursor, 'totalMinor')).toEqual({
      value: '17500',
      id: ID,
    });
  });

  /**
   * Opaque in the §5.1 sense — the client is told not to read it, and the
   * encoding makes that easy to honour. It is deliberately *not* a security
   * boundary: it holds a timestamp and an id the caller is already allowed to
   * see, so there is nothing here worth signing.
   */
  it('is URL-safe and carries no readable punctuation', () => {
    const cursor = encodeCursor(SORT, '2026-06-11T07:32:10.000Z', ID);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  /**
   * The sort is baked in, so a client that pages by date and then switches to
   * price cannot carry a stale cursor across. The comparison is meaningless
   * against a different column, and silently returning the wrong window is
   * worse than a 422 that says to start again.
   */
  it('refuses a cursor cut for a different sort', () => {
    const cursor = encodeCursor('-createdAt', '2026-06-11T07:32:10.000Z', ID);

    expect(() => decodeCursor(cursor, 'totalMinor')).toThrow(AppException);
  });

  it('refuses a cursor cut for the other direction of the same field', () => {
    const cursor = encodeCursor('-createdAt', '2026-06-11T07:32:10.000Z', ID);

    expect(() => decodeCursor(cursor, 'createdAt')).toThrow(AppException);
  });

  describe('refusing rubbish', () => {
    const rejected: [string, string][] = [
      ['not base64 at all', 'not a cursor!!'],
      [
        'valid base64 that is not JSON',
        Buffer.from('hello').toString('base64url'),
      ],
      ['JSON of the wrong shape', Buffer.from('{"a":1}').toString('base64url')],
      [
        'JSON that is not an object',
        Buffer.from('"nope"').toString('base64url'),
      ],
      [
        'an id that is not a uuid',
        Buffer.from(
          JSON.stringify({ s: SORT, v: '2026-06-11T07:32:10.000Z', i: 'nope' }),
        ).toString('base64url'),
      ],
      ['an empty string', ''],
    ];

    it.each(rejected)('refuses %s', (_name, cursor) => {
      expect(() => decodeCursor(cursor, SORT)).toThrow(AppException);
    });

    it('refuses with a 422 naming the parameter', () => {
      try {
        decodeCursor('rubbish', SORT);
        fail('expected a validation error');
      } catch (error) {
        const problem = error as AppException;
        expect(problem.status).toBe(422);
        expect(problem.code).toBe('VALIDATION_FAILED');
        expect(problem.errors?.[0].field).toBe('cursor');
      }
    });
  });
});
