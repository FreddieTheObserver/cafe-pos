import type { Database } from '../../database/database.module';
import { Metrics } from '../../observability/metrics/metrics';
import { sampleOf } from '../../observability/metrics/sample-of';
import { OrderInvalidTransitionError } from '../../orders/errors/orders.errors';
import type { AfterCommit } from '../../realtime/events/after-commit.service';
import type { PaymentProvider } from '../provider/payment-provider';
import { PaymentEventProcessor } from './payment-event-processor.service';

/** A database whose every read fails with `error`. */
const databaseFailingWith = (error: Error) =>
  ({
    query: { paymentEvents: { findFirst: () => Promise.reject(error) } },
    select: () => {
      throw error;
    },
  }) as unknown as Database;

const processorWith = (error: Error, metrics: Metrics) =>
  new PaymentEventProcessor(
    databaseFailingWith(error),
    {} as PaymentProvider,
    {} as AfterCommit,
    metrics,
  );

const failures = (metrics: Metrics) =>
  sampleOf(metrics, 'webhook_processing_failures_total');

describe('PaymentEventProcessor failure counting', () => {
  it('counts an event whose processing threw', async () => {
    const metrics = new Metrics();

    await expect(
      processorWith(new Error('connection reset'), metrics).processEvent('e1'),
    ).resolves.toBe(false);

    expect(await failures(metrics)).toBe(1);
  });

  /**
   * The other instance applied the event between our read and our write, so
   * the guarded transition refused ours. The system worked; counting it would
   * page someone for that.
   */
  it('does not count a lost race', async () => {
    const metrics = new Metrics();

    await processorWith(
      new OrderInvalidTransitionError('PAID', 'PAID'),
      metrics,
    ).processEvent('e1');

    expect(await failures(metrics)).toBe(0);
  });

  it('counts a sweep that could not read the inbox', async () => {
    const metrics = new Metrics();

    await processorWith(new Error('connection reset'), metrics).drainInbox();

    expect(await failures(metrics)).toBe(1);
  });
});
