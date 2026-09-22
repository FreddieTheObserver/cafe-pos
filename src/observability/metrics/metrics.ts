import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry } from 'prom-client';
import type { Namespace } from 'socket.io';
import { orderChannels } from '../../database/schema/enums';
import { ScrapedGauge, type Read } from './scraped-gauge';

export type SocketNamespace = 'kds' | 'kiosk' | 'board';

/** Every (provider, status) the app can end a payment in. Cash is born SUCCEEDED. */
const TERMINAL_PAYMENTS = [
  ['STRIPE', 'SUCCEEDED'],
  ['STRIPE', 'FAILED'],
  ['STRIPE', 'CANCELLED'],
  ['CASH', 'SUCCEEDED'],
] as const;

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

  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'API response time, by the route pattern the request matched.',
    labelNames: ['method', 'route', 'status_class'] as const,
    // 0.3 is an edge so the 300 ms alert reads a boundary instead of interpolating across one.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly ordersCreated = new Counter({
    name: 'orders_created_total',
    help: 'Orders committed, by channel. An idempotent replay is not a new order.',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  readonly payments = new Counter({
    name: 'payments_total',
    help: 'Payments reaching a terminal status, counted once the guarded write has landed.',
    labelNames: ['provider', 'status'] as const,
    registers: [this.registry],
  });

  readonly webhookProcessingFailures = new Counter({
    name: 'webhook_processing_failures_total',
    help: 'Inbox events whose processing threw, excluding a lost race with another instance.',
    registers: [this.registry],
  });

  readonly webhookLag = new Histogram({
    name: 'webhook_lag_seconds',
    help: 'Time from the gateway creating an event to this system first storing it.',
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900, 3600],
    registers: [this.registry],
  });

  readonly reconciliationRuns = new Counter({
    name: 'reconciliation_runs_total',
    help: 'Nightly reconciliation runs, by what they found.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  private reconciliationDelta: number | null = null;
  private readonly namespaces = new Map<SocketNamespace, Namespace>();

  constructor() {
    for (const channel of orderChannels) {
      this.ordersCreated.inc({ channel }, 0);
    }
    for (const [provider, status] of TERMINAL_PAYMENTS) {
      this.payments.inc({ provider, status }, 0);
    }
    for (const outcome of ['agreed', 'delta', 'failed'] as const) {
      this.reconciliationRuns.inc({ outcome }, 0);
    }

    this.scraped(
      {
        name: 'reconciliation_delta_minor',
        help: 'Gateway minus books for the day the last nightly run checked, in minor units. Absent until a run has checked.',
      },
      () =>
        this.reconciliationDelta === null
          ? []
          : [{ labels: {}, value: this.reconciliationDelta }],
    );

    this.scraped(
      {
        name: 'ws_connected',
        help: 'Sockets this instance holds, by namespace.',
        labelNames: ['namespace'] as const,
      },
      () =>
        [...this.namespaces].map(([namespace, server]) => ({
          labels: { namespace },
          value: server.sockets.size,
        })),
    );
  }

  trackNamespace(name: SocketNamespace, server: Namespace): void {
    this.namespaces.set(name, server);
  }

  recordReconciliation(deltaMinor: number): void {
    this.reconciliationDelta = deltaMinor;
    this.reconciliationRuns.inc({
      outcome: deltaMinor === 0 ? 'agreed' : 'delta',
    });
  }

  recordReconciliationFailure(): void {
    this.reconciliationDelta = null;
    this.reconciliationRuns.inc({ outcome: 'failed' });
  }

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
