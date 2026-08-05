import { DependencyUnavailableError } from '../../common/errors/dependency-unavailable.error';
import { ResourceNotFoundError } from '../../common/errors/resource-not-found.error';
import { OrderInvalidTransitionError } from '../errors/orders.errors';
import { isLostRace } from './order-expiry.service';

/**
 * The sweep swallows a lost race on purpose — the customer paid, or a cashier
 * cancelled, in the window between the scan and the update. It must not swallow
 * anything else: a deadlock or a broken connection treated as a lost race would
 * stop expiry making progress in total silence.
 */
describe('isLostRace', () => {
  it('recognises the order having moved on', () => {
    expect(isLostRace(new OrderInvalidTransitionError('PAID', 'EXPIRED'))).toBe(
      true,
    );
  });

  it('recognises the order having been deleted', () => {
    expect(isLostRace(new ResourceNotFoundError('order', 'id'))).toBe(true);
  });

  describe('is not fooled by', () => {
    /**
     * The shapes that actually arrive from the layers underneath. A driver
     * error is a plain `Error` with a SQLSTATE hung off it; pg through Drizzle
     * wraps that again — neither is a domain exception, and both must be loud.
     */
    const faults: [string, unknown][] = [
      [
        'a deadlock from the driver',
        Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      ],
      [
        'a serialization failure',
        Object.assign(new Error('could not serialize'), { code: '40001' }),
      ],
      [
        'a dropped connection',
        Object.assign(new Error('Connection terminated'), {
          code: 'ECONNRESET',
        }),
      ],
      [
        'a Drizzle-wrapped driver error',
        Object.assign(new Error('Failed query'), {
          cause: Object.assign(new Error('deadlock detected'), {
            code: '40P01',
          }),
        }),
      ],
      [
        'another app exception entirely',
        new DependencyUnavailableError('database'),
      ],
      ['a bare error', new Error('boom')],
      ['something thrown that is not an error', 'nope'],
      ['null', null],
      ['undefined', undefined],
    ];

    it.each(faults)('%s', (_name, error) => {
      expect(isLostRace(error)).toBe(false);
    });
  });
});
