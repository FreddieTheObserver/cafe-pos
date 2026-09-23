import { Counter, Registry } from '@prometheus-io/client';
import { ScrapedGauge } from './scraped-gauge';

const setup = () => {
  const registry = new Registry();
  const failures = new Counter({
    name: 'metrics_collector_failures_total',
    help: 'test',
    labelNames: ['collector'] as const,
    registers: [registry],
  });
  return { registry, failures };
};

const valuesOf = async (registry: Registry, name: string) =>
  (await registry.getMetricsAsJSON()).find((metric) => metric.name === name)
    ?.values ?? [];

// Read off the counter itself: going through the registry would scrape again,
// re-run the failing read, and count one failure more than the test caused.
const failuresOf = async (failures: Counter<'collector'>, collector: string) =>
  (await failures.get()).values.find(
    (value) => value.labels.collector === collector,
  )?.value;

describe('ScrapedGauge', () => {
  it('exports what the read returned', async () => {
    const { registry, failures } = setup();
    new ScrapedGauge(
      { name: 'answer', help: 'test', registers: [registry] },
      () => [{ labels: {}, value: 42 }],
      failures,
    );

    expect(await valuesOf(registry, 'answer')).toEqual([
      { labels: {}, value: 42 },
    ]);
  });

  it('reads again on every scrape', async () => {
    const { registry, failures } = setup();
    let reads = 0;
    new ScrapedGauge(
      { name: 'reads', help: 'test', registers: [registry] },
      () => [{ labels: {}, value: ++reads }],
      failures,
    );

    await valuesOf(registry, 'reads');
    expect(await valuesOf(registry, 'reads')).toEqual([
      { labels: {}, value: 2 },
    ]);
  });

  // The client's reset() would have exported 0 here, a number nobody measured.
  it('exports no value, not zero, when the read throws', async () => {
    const { registry, failures } = setup();
    new ScrapedGauge(
      { name: 'broken', help: 'test', registers: [registry] },
      () => Promise.reject(new Error('database is down')),
      failures,
    );

    expect(await valuesOf(registry, 'broken')).toEqual([]);
    expect(await failuresOf(failures, 'broken')).toBe(1);
  });

  it('exports no value when the read outlives its deadline', async () => {
    const { registry, failures } = setup();
    new ScrapedGauge(
      { name: 'slow', help: 'test', registers: [registry] },
      () => new Promise<never>(() => {}),
      failures,
      20,
    );

    expect(await valuesOf(registry, 'slow')).toEqual([]);
    expect(await failuresOf(failures, 'slow')).toBe(1);
  });

  it('does not fall back to the last value it read', async () => {
    const { registry, failures } = setup();
    let failing = false;
    new ScrapedGauge(
      { name: 'flaky', help: 'test', registers: [registry] },
      () =>
        failing
          ? Promise.reject(new Error('gone'))
          : [{ labels: {}, value: 7 }],
      failures,
    );

    expect(await valuesOf(registry, 'flaky')).toEqual([
      { labels: {}, value: 7 },
    ]);
    failing = true;
    expect(await valuesOf(registry, 'flaky')).toEqual([]);
  });

  // A failed read must not fail the scrape, or Prometheus reports the instance down.
  it('serves the rest of the scrape when one read fails', async () => {
    const { registry, failures } = setup();
    new ScrapedGauge(
      { name: 'broken', help: 'test', registers: [registry] },
      () => Promise.reject(new Error('gone')),
      failures,
    );
    new ScrapedGauge(
      { name: 'fine', help: 'test', registers: [registry] },
      () => [{ labels: {}, value: 1 }],
      failures,
    );

    const text = await registry.metrics();
    expect(text).toMatch(/^fine 1$/m);
    expect(text).not.toMatch(/^broken /m);
  });

  it('exports its failure count at zero before anything has failed', async () => {
    const { registry, failures } = setup();
    new ScrapedGauge(
      { name: 'healthy', help: 'test', registers: [registry] },
      () => [{ labels: {}, value: 1 }],
      failures,
    );

    expect(await failuresOf(failures, 'healthy')).toBe(0);
  });
});
