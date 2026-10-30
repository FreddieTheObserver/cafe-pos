import { isOpenAt, type OpeningHours } from './business-hours';

const at = (iso: string) => new Date(iso);

/** UTC+7 all year: the boring baseline. */
const BANGKOK_DAY: OpeningHours = {
  timeZone: 'Asia/Bangkok',
  open: '07:00',
  close: '20:00',
};

describe('isOpenAt', () => {
  it('is open during the day', () => {
    // 17:00 local.
    expect(isOpenAt(at('2026-06-11T10:00:00Z'), BANGKOK_DAY)).toBe(true);
  });

  it('opens on the opening minute, not after it', () => {
    // 06:59 and 07:00 local.
    expect(isOpenAt(at('2026-06-10T23:59:00Z'), BANGKOK_DAY)).toBe(false);
    expect(isOpenAt(at('2026-06-11T00:00:00Z'), BANGKOK_DAY)).toBe(true);
  });

  it('is closed from the closing minute', () => {
    // 19:59 and 20:00 local.
    expect(isOpenAt(at('2026-06-11T12:59:00Z'), BANGKOK_DAY)).toBe(true);
    expect(isOpenAt(at('2026-06-11T13:00:00Z'), BANGKOK_DAY)).toBe(false);
  });

  describe('a window that wraps past midnight', () => {
    const LATE: OpeningHours = {
      timeZone: 'Asia/Bangkok',
      open: '18:00',
      close: '02:00',
    };

    it('is open either side of midnight', () => {
      // 20:00 and 01:30 local.
      expect(isOpenAt(at('2026-06-11T13:00:00Z'), LATE)).toBe(true);
      expect(isOpenAt(at('2026-06-11T18:30:00Z'), LATE)).toBe(true);
    });

    it('is closed between the close and the next open', () => {
      // 02:00 and 12:00 local.
      expect(isOpenAt(at('2026-06-11T19:00:00Z'), LATE)).toBe(false);
      expect(isOpenAt(at('2026-06-11T05:00:00Z'), LATE)).toBe(false);
    });
  });

  /**
   * The case a UTC-naive implementation gets wrong, in both directions: in
   * British Summer Time 06:30 UTC is 07:30 on the wall, and 19:30 UTC is 20:30.
   */
  describe('in a zone with daylight saving', () => {
    const LONDON: OpeningHours = {
      timeZone: 'Europe/London',
      open: '07:00',
      close: '20:00',
    };

    it('reads the summer wall clock', () => {
      expect(isOpenAt(at('2026-07-01T06:30:00Z'), LONDON)).toBe(true);
      expect(isOpenAt(at('2026-07-01T19:30:00Z'), LONDON)).toBe(false);
    });

    it('reads the winter wall clock', () => {
      expect(isOpenAt(at('2026-01-15T06:30:00Z'), LONDON)).toBe(false);
      expect(isOpenAt(at('2026-01-15T19:30:00Z'), LONDON)).toBe(true);
    });
  });

  it('refuses a time that is not HH:MM', () => {
    expect(() =>
      isOpenAt(at('2026-06-11T10:00:00Z'), { ...BANGKOK_DAY, open: '7:00' }),
    ).toThrow(/HH:MM/);
  });
});
