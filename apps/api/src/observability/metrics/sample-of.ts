import type { Metrics } from './metrics';

/**
 * Reads one exported series the way a scrape would.
 *
 * Goes through `getMetricsAsJSON`, which calls every metric's `get()`, so a
 * scraped gauge is read from its source rather than from anything stored.
 * `undefined` means the series is not exported at all, which several tests
 * assert on purpose.
 */
export async function sampleOf(
  metrics: Metrics,
  series: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  for (const metric of await metrics.registry.getMetricsAsJSON()) {
    for (const value of metric.values) {
      const name = (value as { metricName?: string }).metricName ?? metric.name;
      if (name === series && sameLabels(value.labels, labels)) {
        return value.value;
      }
    }
  }
  return undefined;
}

function sameLabels(
  actual: Partial<Record<string, string | number>>,
  expected: Record<string, string>,
): boolean {
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => String(actual[key]) === expected[key])
  );
}
