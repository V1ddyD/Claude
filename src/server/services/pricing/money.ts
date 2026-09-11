/**
 * Money is integer minor units everywhere. Floats are never used for currency:
 * 0.1 + 0.2 is a rounding bug waiting to appear on a quote.
 */
export type Cents = number;

export function formatMoney(cents: Cents, currency: string, locale: string): string {
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
