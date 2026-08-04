import { LogThrottle } from './log-throttle';

const WINDOW_MS = 30_000;

describe('LogThrottle', () => {
  it('lets the first occurrence through', () => {
    const throttle = new LogThrottle(WINDOW_MS);

    expect(throttle.claim(1_000)).toBe('');
  });

  it('suppresses everything inside the window', () => {
    const throttle = new LogThrottle(WINDOW_MS);
    throttle.claim(1_000);

    expect(throttle.claim(2_000)).toBeNull();
    expect(throttle.claim(30_000)).toBeNull();
  });

  it('reports how many it swallowed when the window rolls', () => {
    const throttle = new LogThrottle(WINDOW_MS);
    throttle.claim(0);
    throttle.claim(1_000);
    throttle.claim(2_000);

    expect(throttle.claim(WINDOW_MS)).toBe(
      ' (suppressed since the last log: 2)',
    );
  });

  /**
   * A count of zero is worth omitting rather than printing: " (suppressed
   * since the last log: 0)" on a lone event is noise in the line it is meant
   * to be explaining.
   */
  it('says nothing about suppression when nothing was suppressed', () => {
    const throttle = new LogThrottle(WINDOW_MS);
    throttle.claim(0);

    expect(throttle.claim(WINDOW_MS)).toBe('');
  });

  it('starts a fresh count after each log', () => {
    const throttle = new LogThrottle(WINDOW_MS);
    throttle.claim(0);
    throttle.claim(1_000);
    throttle.claim(WINDOW_MS);

    throttle.claim(WINDOW_MS + 1_000);

    expect(throttle.claim(2 * WINDOW_MS)).toBe(
      ' (suppressed since the last log: 1)',
    );
  });

  /**
   * An incident hours after the last one must not be swallowed because the
   * clock happens to be far from the previous window boundary.
   */
  it('lets a much later occurrence through immediately', () => {
    const throttle = new LogThrottle(WINDOW_MS);
    throttle.claim(0);

    expect(throttle.claim(6 * 60 * 60 * 1_000)).toBe('');
  });
});
