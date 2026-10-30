/**
 * The rate-limit backend could not be reached, so this request has no verdict.
 *
 * Deliberately not an `AppException`: it never reaches a client. It exists only
 * so the guard can tell "Redis is gone" apart from "Redis says you are over the
 * limit" — two conditions that arrive at the same `await` and mean opposite
 * things. Without the distinction the only honest reading of a failure is "some
 * error happened", and the framework's answer to that is a 500 on every route
 * in the application.
 */
export class RateLimitBackendUnavailableError extends Error {
  constructor(cause: unknown) {
    super('The rate-limit backend is unreachable.', { cause });
    this.name = 'RateLimitBackendUnavailableError';
  }
}
