/**
 * Produces the most specific human description available for a thrown value.
 *
 * Infrastructure errors arrive wrapped: Drizzle reports `Failed query: select 1`
 * and hangs the driver error off `cause`; the driver in turn raises an
 * `AggregateError` with an empty message and one nested error per address it
 * tried (IPv6 and IPv4 both refuse, usually with identical text). Reading
 * `.message` yields the useless wrapper, and reading `.cause.message` yields the
 * empty string — both were observed live on `/readyz` during an outage.
 *
 * So: walk to the innermost layer that actually names something, deduplicate
 * per-address repeats, and never hand back an empty string — a readiness probe
 * that says a dependency is down without saying why is barely worth having (§13).
 */
export function describeError(err: unknown): string {
  return detailOf(err, new Set()) || fallbackName(err);
}

/** Depth-first search for the innermost non-empty message. */
function detailOf(err: unknown, seen: Set<unknown>): string {
  if (err === null || typeof err !== 'object' || seen.has(err)) return '';
  seen.add(err);

  const { cause, errors, message } = err as {
    cause?: unknown;
    errors?: unknown;
    message?: unknown;
  };

  const fromCause = detailOf(cause, seen);
  if (fromCause) return fromCause;

  if (Array.isArray(errors)) {
    const nested = [
      ...new Set(errors.map((e) => detailOf(e, seen)).filter(Boolean)),
    ];
    if (nested.length > 0) return nested.join('; ');
  }

  return typeof message === 'string' ? message : '';
}

/** Last resort so the caller always gets something printable. */
function fallbackName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : 'unknown error';
}
