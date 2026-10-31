import { describe, expect, it } from 'vitest';
import { formatCountdown, formatMoney } from '../src/format';

describe('formatMoney', () => {
  it('shows baht with two decimals from satang', () => {
    expect(formatMoney(10900, 'THB')).toBe('฿109.00');
  });

  it('reads the minor unit from the currency, so yen are not divided by 100', () => {
    const text = formatMoney(500, 'JPY');
    expect(text).toContain('500');
    expect(text).not.toContain('5.00');
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [65, '1:05'],
    [600, '10:00'],
  ])('%i seconds is %s', (seconds, text) => {
    expect(formatCountdown(seconds)).toBe(text);
  });
});
