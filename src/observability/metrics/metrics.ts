import { Injectable } from '@nestjs/common';
import { Counter, Registry } from 'prom-client';
import { ScrapedGauge, type Read } from './scraped-gauge';

export interface ScrapedGaugeConfig<T extends string> {
  name: string;
  help: string;
  labelNames?: readonly T[];
  deadlineMs?: number;
}

/**
 * Every instrument the app exports, on a registry of its own.
 *
 * Per app rather than prom-client's global registry: the two-instance suite
 * boots two `AppModule`s in one process, and a shared registry would either
 * refuse the second boot or let two instances count into one series.
 */
@Injectable()
export class Metrics {
  readonly registry = new Registry();

  readonly collectorFailures = new Counter({
    name: 'metrics_collector_failures_total',
    help: 'Scrape-time reads that failed or overran their deadline, by gauge.',
    labelNames: ['collector'] as const,
    registers: [this.registry],
  });

  scraped<T extends string>(
    config: ScrapedGaugeConfig<T>,
    read: Read<T>,
  ): ScrapedGauge<T> {
    const { deadlineMs, ...gauge } = config;
    return new ScrapedGauge<T>(
      { ...gauge, registers: [this.registry] },
      read,
      this.collectorFailures,
      deadlineMs,
    );
  }
}
