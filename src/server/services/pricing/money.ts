/**
 * Money is integer minor units everywhere. Floats are never used for currency:
 * 0.1 + 0.2 is a rounding bug waiting to appear on a quote.
 */
export type Cents = number;

/**
 * How a currency is written where it is spent, when that differs from what
 * Intl prints. Intl writes Brunei dollars as "BND 56,400"; Brunei writes
 * "B$56,400".
 */
const LOCAL_SYMBOLS: Record<string, string> = { BND: 'B$' };

export function formatMoney(cents: Cents, currency: string, locale: string): string {
  const symbol = LOCAL_SYMBOLS[currency];
  if (symbol) {
    return `${symbol}${new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(cents / 100)}`;
  }
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** Signed, for adjustment lines: "+$2,500" / "−$500" / "Included". */
export function formatAdjustment(cents: Cents, currency: string, locale: string): string {
  if (cents === 0) return 'Included';
  const sign = cents > 0 ? '+' : '−';
  return `${sign}${formatMoney(Math.abs(cents), currency, locale)}`;
}
