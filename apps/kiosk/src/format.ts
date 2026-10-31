export const formatMoney = (minor: number, currency: string): string => {
  const money = new Intl.NumberFormat('en-TH', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  });
  const digits = money.resolvedOptions().maximumFractionDigits ?? 2;
  return money.format(minor / 10 ** digits);
};

export const formatCountdown = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
