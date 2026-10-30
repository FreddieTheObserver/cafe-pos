import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';
import { SentryErrorReporter } from './error-reporter';
import { errorReportingOptionsFrom } from './error-reporting';

describe('errorReportingOptionsFrom', () => {
  it('is off without a DSN', () => {
    expect(errorReportingOptionsFrom({})).toBeNull();
  });

  it('reports under the environment the app runs in', () => {
    expect(
      errorReportingOptionsFrom({
        SENTRY_DSN: 'https://key@o0.ingest.sentry.io/0',
        NODE_ENV: 'production',
      }),
    ).toEqual({
      dsn: 'https://key@o0.ingest.sentry.io/0',
      environment: 'production',
    });
  });
});

describe('SentryErrorReporter', () => {
  const sent: ErrorEvent[] = [];

  beforeAll(() => {
    // beforeSend records the event and drops it, so nothing leaves the process.
    Sentry.init({
      dsn: 'https://key@o0.ingest.sentry.io/0',
      skipOpenTelemetrySetup: true,
      beforeSend: (event) => {
        sent.push(event);
        return null;
      },
    });
  });

  afterAll(async () => {
    await Sentry.close();
  });

  it('sends the exception tagged with the route, not the raw path', async () => {
    new SentryErrorReporter().report(new Error('the till fell over'), {
      requestId: 'req-1',
      method: 'POST',
      route: '/api/v1/orders/:id/cancel',
    });
    await Sentry.flush(2000);

    expect(sent).toHaveLength(1);
    expect(sent[0].exception?.values?.[0]?.value).toBe('the till fell over');
    expect(sent[0].tags).toMatchObject({
      method: 'POST',
      route: '/api/v1/orders/:id/cancel',
      request_id: 'req-1',
    });
  });
});
