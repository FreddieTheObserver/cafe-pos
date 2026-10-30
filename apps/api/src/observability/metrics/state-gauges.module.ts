import { Module } from '@nestjs/common';
import { HealthModule } from '../../health/health.module';
import { StateGauges } from './state-gauges';

// Separate from MetricsModule, which stays dependency-free for the probe-module suite.
@Module({ imports: [HealthModule], providers: [StateGauges] })
export class StateGaugesModule {}
