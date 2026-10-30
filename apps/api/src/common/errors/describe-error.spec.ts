import { describeError } from './describe-error';

const REFUSED_V4 = 'connect ECONNREFUSED 127.0.0.1:5499';
const REFUSED_V6 = 'connect ECONNREFUSED ::1:5499';

describe('describeError', () => {
  it('returns a plain error message unchanged', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('prefers a cause over an unhelpful wrapper', () => {
    const wrapped = new Error('Failed query: select 1', {
      cause: new Error(REFUSED_V4),
    });

    expect(describeError(wrapped)).toBe(REFUSED_V4);
  });

  it('reaches through an AggregateError that has no message of its own', () => {
    // Exactly what the pg and ioredis drivers emit for a refused connection.
    const aggregate = new AggregateError(
      [new Error(REFUSED_V6), new Error(REFUSED_V4)],
      '',
    );

    expect(describeError(aggregate)).toBe(`${REFUSED_V6}; ${REFUSED_V4}`);
  });

  it('digs a real cause out of a wrapper whose cause is an empty aggregate', () => {
    // The live /readyz failure: Drizzle wraps the driver, the driver wraps the
    // per-address attempts, and only the innermost layer names anything.
    const drizzleShaped = new Error('Failed query: select 1\nparams: ', {
      cause: new AggregateError([new Error(REFUSED_V4)], ''),
    });

    expect(describeError(drizzleShaped)).toBe(REFUSED_V4);
  });

  it('collapses identical causes rather than repeating them', () => {
    const aggregate = new AggregateError(
      [new Error(REFUSED_V4), new Error(REFUSED_V4)],
      '',
    );

    expect(describeError(aggregate)).toBe(REFUSED_V4);
  });

  it('falls back to the error name when nothing carries a message', () => {
    expect(describeError(new AggregateError([], ''))).toBe('AggregateError');
  });

  it('never returns an empty string, whatever it is handed', () => {
    for (const value of [undefined, null, '', {}, new Error('')]) {
      expect(describeError(value)).toMatch(/\S/);
    }
  });
});
