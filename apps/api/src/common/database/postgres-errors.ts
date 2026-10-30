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
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/** Drizzle wraps driver errors so the SQLSTATE can be one level down. */
function sqlStateOf(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown }).cause ?? error;
  return (cause as { code?: string }).code;
}

export function isUniqueViolation(error: unknown): boolean {
  return sqlStateOf(error) === UNIQUE_VIOLATION;
}

/**
 * A row pointed at a parent that does not exist — the same
 * let-the-database-decide reasoning as above. Checking "does this category
 * exist?" and inserting second leaves a window in which it is deleted, and the
 * FK is the only thing that closes it.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return sqlStateOf(error) === FOREIGN_KEY_VIOLATION;
}

/**
 * A CHECK constraint refused the row (§7.4, "constraints as the last line of
 * defense").
 *
 * The DTOs validate the same rules at the edge, where they can name the
 * offending field. This catches the cases validation structurally cannot reach
 * — a PATCH that moves one half of a two-column invariant while the other half
 * stays in the database — so those surface as the domain's 422 rather than a
 * 500.
 */
export function isCheckViolation(error: unknown): boolean {
  return sqlStateOf(error) === CHECK_VIOLATION;
}
