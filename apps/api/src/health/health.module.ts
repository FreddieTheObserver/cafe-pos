import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { ShutdownDrain } from './shutdown-drain';

/** Liveness/readiness probes. Relies on the global Database and Redis modules. */
@Module({
  controllers: [HealthController],
  providers: [HealthService, ShutdownDrain],
  exports: [HealthService],
})
export class HealthModule {}
