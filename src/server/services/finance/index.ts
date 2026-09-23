import type { Cents } from '@/server/services/pricing';
import { formatMoney } from '@/server/services/pricing';
import { AppError } from '@/server/errors';

/**
 * Finance estimates (spec §40).
 *
 * An ESTIMATE, never an offer. It computes from configured values only —
 * price, down payment, term, APR — and invents no taxes or fees, which spec §6
 * forbids and which would be a real legal exposure if we guessed them
 * (docs/04-spec-review.md §8).
 *
 * Pure: no database, no clock. The disclaimer travels with the numbers so no
 * caller can render the figures without it.
 */

export interface FinanceInput {
  vehiclePriceCents: Cents;
  downPaymentCents?: Cents;
  tradeInValueCents?: Cents;
  termMonths: number;
  /** Basis points. 649 = 6.49%. */
  aprBps: number;
}

export interface FinanceEstimate {
  monthlyPaymentCents: Cents;
  totalOfPaymentsCents: Cents;
  totalInterestCents: Cents;
  amountFinancedCents: Cents;
  termMonths: number;
  aprPercent: number;
  formatted: {
    monthlyPayment: string;
    totalOfPayments: string;
    totalInterest: string;
    amountFinanced: string;
  };
  /** Rendered wherever the numbers are. Not optional. */
  disclaimer: string;
}

const DISCLAIMER =
  'Estimate only. Excludes taxes, registration and dealer fees. ' +
  'Not an offer of credit, and not a guarantee of approval — a specialist confirms ' +
  'final terms.';

export function calculateFinanceEstimate(
  input: FinanceInput,
  display: { currency: string; locale: string; disclaimer?: string },
): FinanceEstimate {
  const { vehiclePriceCents, termMonths, aprBps } = input;
  const downPayment = input.downPaymentCents ?? 0;
  const tradeIn = input.tradeInValueCents ?? 0;

  if (vehiclePriceCents <= 0) {
    throw new AppError('VALIDATION_FAILED', 'A vehicle price is needed for an estimate.');
  }
  if (termMonths < 12 || termMonths > 96) {
    throw new AppError('VALIDATION_FAILED', 'Terms run from 12 to 96 months.');
  }
  if (aprBps < 0 || aprBps > 3000) {
    throw new AppError('VALIDATION_FAILED', 'That interest rate is not valid.');
  }

  const amountFinanced = vehiclePriceCents - downPayment - tradeIn;
  if (amountFinanced <= 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'The down payment and trade-in already cover the price — no financing is needed.',
    );
  }

  // Standard amortisation. Integer cents throughout; the only rounding is the
  // final payment figure, rounded once rather than per period.
  const monthlyRate = aprBps / 10_000 / 12;

  const monthlyPaymentCents =
    monthlyRate === 0
      ? Math.round(amountFinanced / termMonths)
      : Math.round(
          (amountFinanced * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths)),
        );

  const totalOfPaymentsCents = monthlyPaymentCents * termMonths;
  const totalInterestCents = totalOfPaymentsCents - amountFinanced;

  const money = (cents: number) => formatMoney(cents, display.currency, display.locale);

  return {
    monthlyPaymentCents,
    totalOfPaymentsCents,
    totalInterestCents,
    amountFinancedCents: amountFinanced,
    termMonths,
    aprPercent: aprBps / 100,
    formatted: {
      monthlyPayment: money(monthlyPaymentCents),
      totalOfPayments: money(totalOfPaymentsCents),
      totalInterest: money(totalInterestCents),
      amountFinanced: money(amountFinanced),
    },
    // The dealership's own wording where it has one: what an estimate
    // leaves out differs by country, and the dealership knows which.
    disclaimer: display.disclaimer?.trim() || DISCLAIMER,
  };
}

export { DISCLAIMER as FINANCE_DISCLAIMER };
