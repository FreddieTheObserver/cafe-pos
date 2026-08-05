import { businessDayOf } from './business-day';

/** UTC+7 year-round — no DST, which is what makes it the boring baseline. */
const BANGKOK = 'Asia/Bangkok';
const OPENS_AT_5AM = 5;

const at = (iso: string) => new Date(iso);

describe('businessDayOf', () => {
  it('stamps an order placed during trading with that calendar date', () => {
    // 17:00 in Bangkok.
    expect(
      businessDayOf(at('2026-06-11T10:00:00Z'), BANGKOK, OPENS_AT_5AM),
    ).toBe('2026-06-11');
  });

  /**
   * E10, the case the boundary exists for: an order taken after midnight
   * belongs to the day the staff are still working, not the one the clock
   * rolled into. Its queue number and its line in the Z-report follow it there.
   */
  it('keeps an after-midnight order on the day the shift started', () => {
    // 03:00 in Bangkok on the 12th.
    expect(
      businessDayOf(at('2026-06-11T20:00:00Z'), BANGKOK, OPENS_AT_5AM),
    ).toBe('2026-06-11');
  });

  it('rolls over exactly at the opening hour, not before', () => {
    // 04:59:59 local — still yesterday's trade.
    expect(
      businessDayOf(at('2026-06-11T21:59:59Z'), BANGKOK, OPENS_AT_5AM),
    ).toBe('2026-06-11');
    // 05:00:00 local — the new day.
    expect(
      businessDayOf(at('2026-06-11T22:00:00Z'), BANGKOK, OPENS_AT_5AM),
    ).toBe('2026-06-12');
  });

  it('walks back across a month boundary', () => {
    // 03:00 local on 1 July.
    expect(
      businessDayOf(at('2026-06-30T20:00:00Z'), BANGKOK, OPENS_AT_5AM),
    ).toBe('2026-06-30');
  });

  it('walks back across a year boundary', () => {
    // 03:00 local on 1 January 2027.
    expect(
      businessDayOf(at('2026-12-31T20:00:00Z'), BANGKOK, OPENS_AT_5AM),
    ).toBe('2026-12-31');
  });

  it('walks back across a leap day', () => {
    // 03:00 local on 1 March 2028.
    expect(
      businessDayOf(at('2028-02-29T20:00:00Z'), BANGKOK, OPENS_AT_5AM),
    ).toBe('2028-02-29');
  });

  it('treats a zero opening hour as the plain local calendar date', () => {
    expect(businessDayOf(at('2026-06-11T20:00:00Z'), BANGKOK, 0)).toBe(
      '2026-06-12',
    );
    expect(businessDayOf(at('2026-06-11T16:59:59Z'), BANGKOK, 0)).toBe(
      '2026-06-11',
    );
  });

  /**
   * The reason this reads wall-clock time through `Intl` rather than doing
   * fixed-offset arithmetic: in a DST zone the offset is not a property of the
   * zone, it is a property of the instant. A cafe in New York opening at 05:00
   * opens at 05:00 on both sides of the change.
   */
  describe('across a daylight-saving transition', () => {
    const NEW_YORK = 'America/New_York';

    it('uses the pre-transition offset before the clocks move', () => {
      // 01:00 EST (UTC-5) on the morning US clocks spring forward.
      expect(
        businessDayOf(at('2026-03-08T06:00:00Z'), NEW_YORK, OPENS_AT_5AM),
      ).toBe('2026-03-07');
    });

    it('uses the post-transition offset after the clocks move', () => {
      // 08:00 EDT (UTC-4), same morning.
      expect(
        businessDayOf(at('2026-03-08T12:00:00Z'), NEW_YORK, OPENS_AT_5AM),
      ).toBe('2026-03-08');
    });

    it('rolls over at the opening hour in the autumn, when 01:00 happens twice', () => {
      // 00:59 EDT on 1 November, before the 02:00 fallback: still October's day.
      expect(
        businessDayOf(at('2026-11-01T04:59:00Z'), NEW_YORK, OPENS_AT_5AM),
      ).toBe('2026-10-31');
      // 05:00 EST, after the fallback.
      expect(
        businessDayOf(at('2026-11-01T10:00:00Z'), NEW_YORK, OPENS_AT_5AM),
      ).toBe('2026-11-01');
    });
  });

  it('returns a date Postgres accepts verbatim', () => {
    expect(
      businessDayOf(at('2026-06-01T10:00:00Z'), BANGKOK, OPENS_AT_5AM),
    ).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
