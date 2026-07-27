import { Body, Controller, Module, Post } from '@nestjs/common';
import { z } from 'zod';
import { CommonModule } from '../../src/common/common.module';
import { createZodDto } from '../../src/common/validation/zod-dto';
import { HealthController } from '../../src/health/health.controller';
import { HealthService } from '../../src/health/health.service';

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
  ],
})
export class StubbedHealthModule {}
