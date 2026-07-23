import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** Liveness/readiness probes. Relies on the global Database and Redis modules. */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
