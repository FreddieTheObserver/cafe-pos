import {
  Global,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import type { Env } from '../config/env.validation';
import { describeError } from '../common/errors/describe-error';
import {
  ERROR_REPORTER,
  NoopErrorReporter,
  SentryErrorReporter,
} from './errors/error-reporter';
import { sdkHandles } from './sdk-handles';

// Short: the drain has already run, and the platform's grace period is ticking.
const FLUSH_TIMEOUT_MS = 2000;

/** Sends what the SDKs are still holding before the process goes. */
@Injectable()
class ObservabilityShutdown implements OnApplicationShutdown {
  private readonly logger = new Logger('Observability');

  async onApplicationShutdown(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    if (sdkHandles.tracing) pending.push(sdkHandles.tracing.shutdown());
    if (sdkHandles.errorReporting) pending.push(Sentry.close(FLUSH_TIMEOUT_MS));

    for (const result of await Promise.allSettled(pending)) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `Could not flush telemetry on shutdown. ${describeError(result.reason)}`,
        );
      }
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: ERROR_REPORTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('SENTRY_DSN', { infer: true })
          ? new SentryErrorReporter()
          : new NoopErrorReporter(),
    },
    ObservabilityShutdown,
  ],
  exports: [ERROR_REPORTER],
})
export class ObservabilityModule {}
