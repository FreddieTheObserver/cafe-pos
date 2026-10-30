import * as Sentry from '@sentry/node';

export interface ErrorReportingOptions {
  dsn: string;
  environment: string;
}

export function errorReportingOptionsFrom(
  env: NodeJS.ProcessEnv,
): ErrorReportingOptions | null {
  if (!env.SENTRY_DSN) return null;
  return { dsn: env.SENTRY_DSN, environment: env.NODE_ENV ?? 'development' };
}

/**
 * Starts Sentry for exceptions only, or does nothing without a DSN.
 *
 * `skipOpenTelemetrySetup` because `startTracing` owns OpenTelemetry: two SDKs
 * registering the global tracer and context manager would fight over both.
 * `sendDefaultPii` stays off, in keeping with §7.5's minimisation.
 */
export function startErrorReporting(env: NodeJS.ProcessEnv): boolean {
  const options = errorReportingOptionsFrom(env);
  if (options === null) return false;

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    skipOpenTelemetrySetup: true,
    sendDefaultPii: false,
  });
  return true;
}
