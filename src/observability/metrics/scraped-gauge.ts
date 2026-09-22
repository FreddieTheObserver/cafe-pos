import { Logger } from '@nestjs/common';
import { Gauge, type Counter, type GaugeConfiguration } from 'prom-client';
import { describeError } from '../../common/errors/describe-error';
import { LogThrottle } from '../../common/logging/log-throttle';

export interface Sample<T extends string> {
  labels: Partial<Record<T, string | number>>;
  value: number;
}

export type Read<T extends string> = () => Sample<T>[] | Promise<Sample<T>[]>;

const DEFAULT_DEADLINE_MS = 2000;

// A dead database fails every read on every scrape; one line a minute is enough to say so.
const FAILURE_LOG_INTERVAL_MS = 60_000;

/**
 * A gauge read at scrape time that exports nothing, never a stale value and
 * never zero, when its read fails.
 *
 * prom-client's `reset()` puts an unlabelled gauge back to 0, so its own
 * `collect` hook cannot say "unknown": a failed read would publish a zero
 * nobody measured. Overriding `get()` bypasses the stored values entirely, so
 * what is exported is exactly what this scrape read.
 */
export class ScrapedGauge<T extends string = string> extends Gauge<T> {
  private readonly logger = new Logger('Metrics');
  private readonly failureLog = new LogThrottle(FAILURE_LOG_INTERVAL_MS);
  private readonly collector: string;

  constructor(
    config: Omit<GaugeConfiguration<T>, 'collect'>,
    private readonly read: Read<T>,
    private readonly failures: Counter<'collector'>,
    private readonly deadlineMs: number = DEFAULT_DEADLINE_MS,
  ) {
    super(config);
    this.collector = config.name;
    failures.inc({ collector: config.name }, 0);
  }

  override async get() {
    const metric = await super.get();
    return { ...metric, values: await this.readOrNothing() };
  }

  private async readOrNothing(): Promise<Sample<T>[]> {
    try {
      return await withDeadline(
        Promise.resolve().then(() => this.read()),
        this.deadlineMs,
      );
    } catch (error) {
      this.failures.inc({ collector: this.collector });
      const suffix = this.failureLog.claim();
      if (suffix !== null) {
        this.logger.warn(
          `Could not read ${this.collector}; exporting no value. ${describeError(error)}${suffix}`,
        );
      }
      return [];
    }
  }
}

function withDeadline<V>(work: Promise<V>, ms: number): Promise<V> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`read exceeded its ${ms}ms deadline`)),
      ms,
    );
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
