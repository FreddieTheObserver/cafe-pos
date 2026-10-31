/**
 * The tablet's clock may be wrong; the server's is the one that expires orders.
 * Each response's `Date` header gives an offset, and the latest one wins.
 * (`Date` has one-second resolution, so this is good to about a second — plenty for a countdown.)
 */
export const createServerClock = (now: () => number = Date.now) => {
  let offsetMs = 0;
  return {
    sync(serverNow: Date) {
      offsetMs = serverNow.getTime() - now();
    },
    now: () => now() + offsetMs,
    /** Whole seconds until `iso`, floored at 0. */
    secondsUntil(iso: string): number {
      return Math.max(
        0,
        Math.ceil((Date.parse(iso) - (now() + offsetMs)) / 1000),
      );
    },
  };
};
