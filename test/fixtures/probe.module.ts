import { Body, Controller, Get, Global, Module, Post } from '@nestjs/common';
import { z } from 'zod';
import { CommonModule } from '../../src/common/common.module';
import { DependencyUnavailableError } from '../../src/common/errors/dependency-unavailable.error';
import { createZodDto } from '../../src/common/validation/zod-dto';
import { HealthController } from '../../src/health/health.controller';
import { HealthService } from '../../src/health/health.service';
import {
  ERROR_REPORTER,
  type ErrorContext,
  type ErrorReporter,
} from '../../src/observability/errors/error-reporter';
import { ShutdownDrain } from '../../src/health/shutdown-drain';

const EchoSchema = z.object({
  name: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(50),
});

export class EchoDto extends createZodDto(EchoSchema) {}

/**
 * Stand-in for the real endpoints Phase 1+ will add. Exists so the HTTP
 * contract (validation envelope, body limits, security headers) can be tested
 * against production wiring without waiting on domain routes.
 */
@Controller('probe')
export class ProbeController {
  /** Validated by the global pipe via the DTO's schema. */
  @Post('echo')
  echo(@Body() body: EchoDto): EchoDto {
    return body;
  }

  /** An unplanned failure: the kind a human is asked to look at. */
  @Get('fault')
  fault(): never {
    throw new Error('the probe fell over');
  }

  /** A dependency outage: a 5xx raised on purpose, which is a condition, not a fault. */
  @Get('unavailable')
  unavailable(): never {
    throw new DependencyUnavailableError('The probe dependency is down.');
  }

  /** Unvalidated on purpose — used to exercise the body-size limit. */
  @Post('bulk')
  bulk(): { ok: true } {
    return { ok: true };
  }
}

@Module({ imports: [CommonModule], controllers: [ProbeController] })
export class ProbeModule {}

/**
 * The real health controller with its dependency checks stubbed out. Lets the
 * base-path exclusion (§5.1) be asserted on the routes that actually carry it,
 * while keeping the suite free of Postgres and Redis.
 */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: HealthService,
      useValue: {
        checkReadiness: () =>
          Promise.resolve({
            ok: true,
            checks: { db: { status: 'up' }, redis: { status: 'up' } },
          }),
      },
    },
    { provide: ShutdownDrain, useValue: { isDraining: false } },
  ],
})
export class StubbedHealthModule {}

/** Records what the exception filter would have sent to Sentry. */
export class RecordingErrorReporter implements ErrorReporter {
  readonly reports: { error: unknown; context: ErrorContext }[] = [];

  report(error: unknown, context: ErrorContext): void {
    this.reports.push({ error, context });
  }
}

export const recordingReporter = new RecordingErrorReporter();

@Global()
@Module({
  providers: [{ provide: ERROR_REPORTER, useValue: recordingReporter }],
  exports: [ERROR_REPORTER],
})
export class RecordingErrorReportingModule {}
