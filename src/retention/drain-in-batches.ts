export interface DrainOptions {
  batchSize: number;
  /** Bounds one run; whatever is left is taken on the next. */
  maxBatches?: number;
}

const DEFAULT_MAX_BATCHES = 100;

/**
 * Runs `step` until a batch comes back short, or the cap is reached, and
 * returns how many rows were handled in total.
 *
 * `step` must handle at most `limit` rows and return how many it did. Batches
 * keep each statement's locks short; the cap keeps one run from monopolising
 * the database after a long outage left a backlog.
 */
export async function drainInBatches(
  step: (limit: number) => Promise<number>,
  { batchSize, maxBatches = DEFAULT_MAX_BATCHES }: DrainOptions,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const handled = await step(batchSize);
    total += handled;
    if (handled < batchSize) break;
  }
  return total;
}
