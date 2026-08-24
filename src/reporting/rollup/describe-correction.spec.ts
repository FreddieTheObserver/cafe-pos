import { describeCorrection } from './describe-correction';

/**
 * The one line that makes a silent correction visible. Pure, so what it says
 * can be pinned without a database — and it is worth pinning, because the
 * whole point of the re-roll window is that these changes stop being invisible.
 */
describe('describeCorrection', () => {
  const day = {
    ordersCompleted: 4,
    ordersRefunded: 0,
    ordersCancelled: 1,
    ordersExpired: 0,
    ordersSettled: 4,
    revenueMinor: 40_000,
    refundsMinor: 0,
    vatMinor: 2_617,
  };

  it('says nothing about a re-roll that reproduced the row', () => {
    expect(describeCorrection(day, { ...day })).toBeNull();
  });

  it('names the field, the old value and the new one', () => {
    expect(describeCorrection(day, { ...day, revenueMinor: 50_000 })).toBe(
      'revenueMinor 40000 → 50000',
    );
  });

  /**
   * A late webhook moves revenue *and* the counts that revenue was earned by,
   * so a report of one field alone would understate what changed.
   */
  it('lists every field that moved, in one line', () => {
    expect(
      describeCorrection(day, {
        ...day,
        ordersCompleted: 5,
        ordersSettled: 5,
        revenueMinor: 50_000,
      }),
    ).toBe(
      'ordersCompleted 4 → 5, ordersSettled 4 → 5, revenueMinor 40000 → 50000',
    );
  });

  /**
   * A refund landing after close leaves revenue alone and moves only the
   * refund total — the case a comparison limited to revenue would miss.
   */
  it('catches a change that never touches revenue', () => {
    expect(describeCorrection(day, { ...day, refundsMinor: 10_000 })).toBe(
      'refundsMinor 0 → 10000',
    );
  });

  /**
   * Zero is a value, not an absence. A day whose only completed order was
   * later cancelled goes to zero, and reporting nothing there would hide the
   * single most alarming correction this can produce.
   */
  it('reports a fall to zero', () => {
    expect(
      describeCorrection(day, { ...day, ordersCompleted: 0, revenueMinor: 0 }),
    ).toBe('ordersCompleted 4 → 0, revenueMinor 40000 → 0');
  });
});
