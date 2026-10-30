import { Global, Module } from '@nestjs/common';
import { Metrics } from './metrics';
import { MetricsServer } from './metrics-server';

/**
 * Global, and deliberately dependency-free: `configureApp` reads `Metrics`, and
 * the probe-module suite runs `configureApp` without a database or Redis.
 */
@Global()
@Module({
  providers: [Metrics, MetricsServer],
  exports: [Metrics, MetricsServer],
})
export class MetricsModule {}
