import * as Sentry from '@sentry/node';

export const ERROR_REPORTER = Symbol('ERROR_REPORTER');

export interface ErrorContext {
  requestId: string;
  method: string;
  /** The matched route pattern, never the raw path, so ids stay out of the tags. */
  route: string;
}

/**
 * Where an unplanned failure goes for a human to look at (§13's Sentry).
 *
 * A port, so the exception filter does not import Sentry and tests can record
 * what would have been sent.
 */
export interface ErrorReporter {
  report(error: unknown, context: ErrorContext): void;
}

/** When no DSN is configured: the log line is the only record, as before. */
export class NoopErrorReporter implements ErrorReporter {
  report(): void {}
}

export class SentryErrorReporter implements ErrorReporter {
  report(error: unknown, context: ErrorContext): void {
    Sentry.captureException(error, {
      tags: {
        method: context.method,
        route: context.route,
        request_id: context.requestId,
      },
    });
  }
}
