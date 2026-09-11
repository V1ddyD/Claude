import { describe, it, expect } from 'vitest';
import { calculateFinanceEstimate } from '../../src/server/services/finance';
import { isAppError } from '../../src/server/errors';

const DISPLAY = { currency: 'CAD', locale: 'en-CA' };

describe('finance estimates', () => {
  it('amortises correctly', () => {
    // $58,900 with $10,000 down over 60 months at 6.49%.
    const estimate = calculateFinanceEstimate(
      { vehiclePriceCents: 5_890_000, downPaymentCents: 1_000_000, termMonths: 60, aprBps: 649 },
      DISPLAY,
    );

    expect(estimate.amountFinancedCents).toBe(4_890_000);
    // P·r / (1 − (1+r)^−n) with P = 4,890,000c, r = 0.0649/12, n = 60
    // gives 95,655.56c, which rounds to 95,656c — $956.56 a month.
    expect(estimate.monthlyPaymentCents).toBe(95_656);
    expect(estimate.formatted.monthlyPayment).toBe('$957');
    expect(estimate.totalInterestCents).toBe(
      estimate.totalOfPaymentsCents - estimate.amountFinancedCents,
    );
  });

  it('counts a trade-in toward the down payment', () => {
    const withTrade = calculateFinanceEstimate(
      {
        vehiclePriceCents: 5_890_000, downPaymentCents: 500_000,
        tradeInValueCents: 1_500_000, termMonths: 60, aprBps: 649,
      },
      DISPLAY,
    );
    expect(withTrade.amountFinancedCents).toBe(3_890_000);
  });

  it('handles a zero interest rate without dividing by zero', () => {
    const estimate = calculateFinanceEstimate(
      { vehiclePriceCents: 4_800_000, termMonths: 48, aprBps: 0 },
      DISPLAY,
    );
    expect(estimate.monthlyPaymentCents).toBe(100_000);
    expect(estimate.totalInterestCents).toBe(0);
  });

  it('always carries the disclaimer with the numbers', () => {
    const estimate = calculateFinanceEstimate(
      { vehiclePriceCents: 5_000_000, termMonths: 60, aprBps: 649 },
      DISPLAY,
    );
    expect(estimate.disclaimer).toContain('Estimate only');
    expect(estimate.disclaimer).toContain('Not an offer of credit');
    // No invented taxes or fees (spec §6).
    expect(estimate.disclaimer).toContain('Excludes taxes');
    expect(estimate.amountFinancedCents).toBe(5_000_000);
  });

  it('refuses an impossible term', () => {
    for (const termMonths of [6, 120]) {
      try {
        calculateFinanceEstimate({ vehiclePriceCents: 5_000_000, termMonths, aprBps: 649 }, DISPLAY);
        expect.unreachable('should have refused');
      } catch (err) {
        expect.soft(isAppError(err) && err.code).toBe('VALIDATION_FAILED');
      }
    }
  });

  it('refuses when nothing needs financing', () => {
    try {
      calculateFinanceEstimate(
        { vehiclePriceCents: 5_000_000, downPaymentCents: 5_000_000, termMonths: 60, aprBps: 649 },
        DISPLAY,
      );
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.message).toContain('no financing is needed');
    }
  });

  it('never produces a payment below the unfinanced monthly cost', () => {
    // Property: interest cannot make a loan cheaper than paying it off flat.
    for (const aprBps of [0, 199, 649, 1299, 2400]) {
      const estimate = calculateFinanceEstimate(
        { vehiclePriceCents: 6_000_000, termMonths: 60, aprBps },
        DISPLAY,
      );
      expect.soft(estimate.monthlyPaymentCents).toBeGreaterThanOrEqual(6_000_000 / 60);
      expect.soft(estimate.totalInterestCents).toBeGreaterThanOrEqual(0);
    }
  });
});
