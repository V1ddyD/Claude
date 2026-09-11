import { describe, it, expect } from 'vitest';
import { scoreLead, DEFAULT_SCORING_RULES, DEFAULT_BANDS } from '../../src/server/services/scoring/rules';
import { flattenSignals, leadSignalsSchema } from '../../src/server/services/scoring/signals';
import type { LeadSignals } from '../../src/server/services/scoring/signals';

/**
 * Lead priority, against the anchor cases in spec §11.
 *
 * These three conversations are the specification's own examples, and they are
 * the regression guard for every future change to the weights: if a tuning
 * change makes "I'm just browsing" a hot lead, this fails.
 */

const certain = <T>(value: T) => ({ value, confidence: 0.95 });

function score(signals: LeadSignals) {
  return scoreLead(flattenSignals(signals), DEFAULT_SCORING_RULES, DEFAULT_BANDS);
}

describe('the specification anchor cases', () => {
  it('"I am looking at cars for next year" is LOW', () => {
    const result = score({
      purchaseTimeframe: certain('over_six_months'),
      justBrowsing: certain(true),
    });
    expect(result.priority).toBe('low');
  });

  it('"comparing the S5 and an X3, budget around $50k" is MEDIUM', () => {
    const result = score({
      modelSlug: certain('s5'),
      budgetCents: certain(5_000_000),
      purchaseTimeframe: certain('one_to_three_months'),
    });
    // 8 (model named) + 10 (budget) + 12 (timeframe) = 30, exactly the MEDIUM
    // threshold. Asserted precisely so a weight change cannot silently move it.
    expect(result.score).toBe(30);
    expect(result.priority).toBe('medium');
  });

  it('"S5 Premium AWD in black, financing ready, test drive Saturday" is HIGH', () => {
    const result = score({
      modelSlug: certain('s5'),
      trimCode: certain('PREMIUM'),
      powertrainCode: certain('2.0T-AWD'),
      exteriorColourCode: certain('OBSIDIAN'),
      financeInterest: certain(true),
      testDriveRequested: certain(true),
      testDriveDate: certain('2026-09-19'),
      purchaseTimeframe: certain('within_30_days'),
    });
    expect(result.priority).toBe('high');
  });
});

describe('the rationale shown to staff', () => {
  it('states evidence, not reasoning', () => {
    const result = score({
      modelSlug: certain('s5'),
      trimCode: certain('PREMIUM'),
      powertrainCode: certain('2.0T-AWD'),
      testDriveRequested: certain(true),
      testDriveDate: certain('2026-09-19'),
      purchaseTimeframe: certain('one_to_three_months'),
    });

    expect(result.rationale).toContain('High priority');
    expect(result.rationale).toContain('requested a test drive with a date');
    expect(result.rationale).toContain('selected a specific model, trim and powertrain');
    // One fact, described once: the general "asked about a test drive" rule is
    // superseded by the specific one rather than firing alongside it.
    expect(result.firedRules).not.toContain('test_drive_requested');
    expect(result.firedRules).not.toContain('model_identified');
    // No chain of thought, no model commentary (spec §11).
    expect(result.rationale).not.toMatch(/because I|I think|reasoning|step/i);
  });

  it('says so plainly when there is nothing to go on', () => {
    expect(score({}).rationale).toBe('Low priority: no strong buying signals yet.');
  });

  it('never lists a negative signal as a reason for the score', () => {
    const result = score({ justBrowsing: certain(true), modelSlug: certain('s5') });
    expect(result.rationale).not.toContain('only browsing');
  });
});

describe('confidence', () => {
  it('ignores a signal the model was unsure about', () => {
    const confident = score({ budgetCents: certain(5_500_000) });
    const unsure = score({ budgetCents: { value: 5_500_000, confidence: 0.3 } });

    expect(confident.firedRules).toContain('budget_stated');
    // A half-heard budget must not manufacture a hotter lead (spec §26).
    expect(unsure.firedRules).not.toContain('budget_stated');
    expect(unsure.score).toBeLessThan(confident.score);
  });

  it('requires higher confidence for contact details than for interest', () => {
    const result = score({ customerEmail: { value: 'a@b.test', confidence: 0.65 } });
    expect(result.firedRules).not.toContain('contactable');
  });
});

describe('scoring mechanics', () => {
  it('clamps to 0-100 so added rules cannot push everything to HIGH', () => {
    const everything = score({
      modelSlug: certain('s5'), trimCode: certain('PREMIUM'), powertrainCode: certain('2.0T-AWD'),
      budgetCents: certain(9_000_000), purchaseTimeframe: certain('immediately'),
      financeInterest: certain(true), tradeInInterest: certain(true),
      testDriveRequested: certain(true), testDriveDate: certain('2026-09-19'),
      wantsSalesperson: certain(true), negotiatingPrice: certain(true),
      askedAboutAvailability: certain(true), customerEmail: certain('a@b.test'),
    });
    expect(everything.score).toBe(100);
    expect(everything.priority).toBe('high');
  });

  it('never goes below zero', () => {
    const result = score({ justBrowsing: certain(true), purchaseTimeframe: certain('over_six_months') });
    expect(result.score).toBe(0);
    expect(result.priority).toBe('low');
  });

  it('is deterministic', () => {
    const signals: LeadSignals = { modelSlug: certain('s5'), budgetCents: certain(5_000_000) };
    expect(score(signals)).toEqual(score(signals));
  });

  it('honours tenant-configured bands', () => {
    const signals = flattenSignals({ budgetCents: certain(5_000_000), financeInterest: certain(true) });
    const strict = scoreLead(signals, DEFAULT_SCORING_RULES, { high: 90, medium: 80 });
    const loose = scoreLead(signals, DEFAULT_SCORING_RULES, { high: 15, medium: 5 });
    expect(strict.priority).toBe('low');
    expect(loose.priority).toBe('high');
  });
});

describe('the extraction schema', () => {
  it('rejects a signal with no confidence', () => {
    const parsed = leadSignalsSchema.safeParse({ budgetCents: { value: 50000 } });
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed email rather than storing it', () => {
    const parsed = leadSignalsSchema.safeParse({
      customerEmail: { value: 'not-an-email', confidence: 0.9 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an invented purchase timeframe', () => {
    const parsed = leadSignalsSchema.safeParse({
      purchaseTimeframe: { value: 'next tuesday', confidence: 0.9 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a negative budget', () => {
    const parsed = leadSignalsSchema.safeParse({
      budgetCents: { value: -100, confidence: 0.9 },
    });
    expect(parsed.success).toBe(false);
  });

  it('drops nulls when flattening, so absence is not evidence', () => {
    const flat = flattenSignals({ modelSlug: certain('s5'), budgetCents: null });
    expect(flat.map((f) => f.field)).toEqual(['modelSlug']);
  });
});
