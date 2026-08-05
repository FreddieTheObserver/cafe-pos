/**
 * The business day an instant belongs to (B7, E10).
 *
 * A cafe's day is not the calendar's. An order rung up at 00:30 belongs to the
 * shift that started the previous morning: it takes that day's queue number and
 * it lands on that day's Z-report. The boundary is configurable and defaults to
 * 05:00 local, which is before any cafe opens and after any cafe closes.
 *
 * Everything about this function is calendar arithmetic, deliberately. The
 * value is a `date` column, not a timestamp — "which trading day" is a label,
 * and storing it as an instant would invite a timezone conversion at every
 * read.
 */
export function businessDayOf(
  instant: Date,
  timeZone: string,
  startHour: number,
): string {
  const { year, month, day, hour } = localWallClock(instant, timeZone);

  // Before opening, the shift still belongs to yesterday.
  if (hour >= startHour) return formatDate(year, month, day);

  /**
   * Stepping back a day through `Date.UTC` rather than through the zone is what
   * keeps this correct across a daylight-saving change. The pieces are already
   * local wall-clock numbers, so treating them as UTC makes the subtraction
   * pure calendar arithmetic — no offset to apply twice, and no 23-hour day to
   * trip over. Month lengths and leap years come from the platform.
   */
  const previous = new Date(Date.UTC(year, month - 1, day) - MILLIS_PER_DAY);
  return formatDate(
    previous.getUTCFullYear(),
    previous.getUTCMonth() + 1,
    previous.getUTCDate(),
  );
}

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
}

/**
 * What a clock on the cafe wall reads at this instant.
 *
 * Read through `Intl` rather than computed from a stored UTC offset, because in
 * a DST zone the offset is a property of the *instant*, not of the zone. A cafe
 * that opens at 05:00 opens at 05:00 on both sides of a transition, and only
 * the platform's timezone database knows which offset applies on a given
 * morning.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`: the latter renders midnight
 * as hour 24 under some ICU builds, which would put every order in the first
 * hour of the day on the wrong side of the comparison above.
 */
function localWallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    // Unreachable for the fields requested above; throwing beats a silent NaN
    // propagating into a business day.
    if (part === undefined) {
      throw new Error(`Intl did not return a "${type}" part for ${timeZone}`);
    }
    return Number(part.value);
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
  };
}

/** `YYYY-MM-DD` — what a Postgres `date` column takes without conversion. */
function formatDate(year: number, month: number, day: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}
