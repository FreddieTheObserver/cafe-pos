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
});
