import type { Namespace } from 'socket.io';
import { Metrics } from './metrics';
import { sampleOf } from './sample-of';

// Zero from the first scrape, so `increase()` has a series before the first sale.
describe('Metrics', () => {
  it('exports every order channel at zero before the first order', async () => {
    const metrics = new Metrics();

    expect(
      await sampleOf(metrics, 'orders_created_total', { channel: 'KIOSK' }),
    ).toBe(0);
    expect(
      await sampleOf(metrics, 'orders_created_total', { channel: 'COUNTER' }),
    ).toBe(0);
  });

  it('exports every payment outcome at zero before the first payment', async () => {
    const metrics = new Metrics();

    for (const [provider, status] of [
      ['STRIPE', 'SUCCEEDED'],
      ['STRIPE', 'FAILED'],
      ['STRIPE', 'CANCELLED'],
      ['CASH', 'SUCCEEDED'],
    ]) {
      expect(
        await sampleOf(metrics, 'payments_total', { provider, status }),
      ).toBe(0);
    }
  });

  describe('reconciliation', () => {
    it('exports no delta until a run has checked', async () => {
      expect(
        await sampleOf(new Metrics(), 'reconciliation_delta_minor'),
      ).toBeUndefined();
    });

    it('publishes the delta a run found, and counts the run by outcome', async () => {
      const metrics = new Metrics();

      metrics.recordReconciliation(-500);

      expect(await sampleOf(metrics, 'reconciliation_delta_minor')).toBe(-500);
      expect(
        await sampleOf(metrics, 'reconciliation_runs_total', {
          outcome: 'delta',
        }),
      ).toBe(1);
    });

    // "Could not check" must not leave "checked and it agrees" standing.
    it('clears the delta when a run could not check', async () => {
      const metrics = new Metrics();
      metrics.recordReconciliation(0);

      metrics.recordReconciliationFailure();

      expect(
        await sampleOf(metrics, 'reconciliation_delta_minor'),
      ).toBeUndefined();
      expect(
        await sampleOf(metrics, 'reconciliation_runs_total', {
          outcome: 'failed',
        }),
      ).toBe(1);
    });
  });

  it('reports the sockets each tracked namespace holds', async () => {
    const metrics = new Metrics();
    const kds = {
      sockets: new Map([
        ['a', {}],
        ['b', {}],
      ]),
    } as unknown as Namespace;

    metrics.trackNamespace('kds', kds);

    expect(await sampleOf(metrics, 'ws_connected', { namespace: 'kds' })).toBe(
      2,
    );
  });
});
