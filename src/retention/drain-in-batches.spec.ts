import { drainInBatches } from './drain-in-batches';

/** A step that reports the given batch sizes in turn, and records each call. */
const stepReturning = (...sizes: number[]) => {
  const calls: number[] = [];
  const step = (limit: number) => {
    calls.push(limit);
    return Promise.resolve(sizes.shift() ?? 0);
  };
  return { step, calls };
};

describe('drainInBatches', () => {
  it('stops at the first batch that comes back short', async () => {
    const { step, calls } = stepReturning(100, 100, 40, 100);

    await expect(drainInBatches(step, { batchSize: 100 })).resolves.toBe(240);
    expect(calls).toHaveLength(3);
  });

  it('asks every batch for the batch size', async () => {
    const { step, calls } = stepReturning(5, 0);

    await drainInBatches(step, { batchSize: 5 });

    expect(calls).toEqual([5, 5]);
  });

  it('makes one call when there is nothing to do', async () => {
    const { step, calls } = stepReturning(0);

    await expect(drainInBatches(step, { batchSize: 100 })).resolves.toBe(0);
    expect(calls).toHaveLength(1);
  });

  // A backlog after an outage is worked off over several runs, not in one long one.
  it('stops at the cap however much is left', async () => {
    const { step, calls } = stepReturning(10, 10, 10, 10, 10);

    await expect(
      drainInBatches(step, { batchSize: 10, maxBatches: 3 }),
    ).resolves.toBe(30);
    expect(calls).toHaveLength(3);
  });
});
