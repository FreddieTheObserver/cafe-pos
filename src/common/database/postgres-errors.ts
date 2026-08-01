/**
 * Postgres SQLSTATE branching (§7.4).
 *
 * Services let the database be the authority on uniqueness rather than checking
 * first and inserting second: between those two statements another request can
 * take the value, and only the index is actually atomic. That makes "was this a
 * constraint violation, and which one?" a question several services ask, so the
 * error-unwrapping lives here once.
 */

const UNIQUE_VIOLATION = '23505';

/** Drizzle wraps driver errors so the SQLSTATE can be one level down. */
function sqlStateOf(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown }).cause ?? error;
  return (cause as { code?: string }).code;
}

export function isUniqueViolation(error: unknown): boolean {
  return sqlStateOf(error) === UNIQUE_VIOLATION;
}
