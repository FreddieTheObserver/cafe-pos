/** A 24-hour `HH:MM`. Shared with the env schema so the two cannot disagree. */
export const CLOCK_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface OpeningHours {
  timeZone: string;
  /** `HH:MM` on the wall clock of `timeZone`. */
  open: string;
  close: string;
}

/**
 * Whether the cafe is open at `instant`: inside `[open, close)` on the local
 * wall clock, wrapping past midnight when `close` is earlier than `open`.
 */
export function isOpenAt(instant: Date, hours: OpeningHours): boolean {
  const now = minuteOfDay(instant, hours.timeZone);
  const open = minutesOf(hours.open);
  const close = minutesOf(hours.close);

  return open < close ? now >= open && now < close : now >= open || now < close;
}

function minutesOf(clockTime: string): number {
  const match = CLOCK_TIME.exec(clockTime);
  if (match === null) {
    throw new Error(`"${clockTime}" is not a 24-hour HH:MM time`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function minuteOfDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`Intl did not return a "${type}" part for ${timeZone}`);
    }
    return Number(part.value);
  };

  return read('hour') * 60 + read('minute');
}
