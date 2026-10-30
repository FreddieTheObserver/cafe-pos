/**
 * Rate-limits a repeating log line, counting what it swallowed.
 *
 * For failures that recur per *request* rather than per incident: an outage
 * lasting minutes produces one line per affected call, and the volume buries
 * the lines that explain it. The shape mirrors `attachRedisDiagnostics`, which
 * learned it the hard way — an unthrottled ioredis listener produced ~57 lines
 * in 9 seconds — except that this has no "recovered" event to reset against,
 * because a request either found the dependency or did not.
 *
 * The first occurrence always logs, so an operator sees the incident open at
 * once rather than up to a window later.
 */
export class LogThrottle {
  private lastLoggedAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;

  constructor(private readonly intervalMs: number) {}

  /**
   * Asks permission to log now.
   *
   * Returns `null` when the caller should stay quiet, or a suffix to append to
   * its message — empty when nothing was suppressed, and a count otherwise. The
   * count rides on the line it belongs to rather than being logged separately,
   * so "this is still happening, 400 times" is one entry and not two.
   *
   * `now` is a parameter so the window is testable without a fake clock.
   */
  claim(now: number = Date.now()): string | null {
    if (now - this.lastLoggedAt < this.intervalMs) {
      this.suppressed += 1;
      return null;
    }

    const suffix =
      this.suppressed > 0
        ? ` (suppressed since the last log: ${this.suppressed})`
        : '';
    this.lastLoggedAt = now;
    this.suppressed = 0;
    return suffix;
  }
}
