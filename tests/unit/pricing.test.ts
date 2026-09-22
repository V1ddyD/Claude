import { describe, it, expect } from 'vitest';
import { priceBuild } from '../../src/server/services/pricing';
import type { BuildContext } from '../../src/server/services/pricing';
import { isAppError } from '../../src/server/errors';

/**
 * The configurator's rules, tested as pure functions.
 *
 * Base 52,900 + powertrain 3,500 + trim 2,500 = 58,900, which is what the
 * configuration row must say. That invariant is asserted by the engine itself,
 * so a seed or an admin edit that breaks it cannot quietly produce a wrong quote.
 */
function context(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    currency: 'CAD',
    locale: 'en-CA',
    model: { slug: 's5', name: 'S5', fullName: 'Sinclair S5', baseMsrpCents: 5_290_000 },
    powertrain: { code: '2.0T-AWD', name: '2.0 Turbo AWD', priceDeltaCents: 350_000 },
    trim: { code: 'PREMIUM', name: 'Premium', priceDeltaCents: 250_000 },
    configuration: { id: 'cfg-1', priceCents: 5_890_000, isOrderable: true },
    exteriorColours: [
      { code: 'OBSIDIAN', name: 'Obsidian Black', kind: 'exterior', priceDeltaCents: 0 },
      { code: 'GLACIER', name: 'Glacier Pearl', kind: 'exterior', priceDeltaCents: 90_000 },
    ],
    interiorColours: [
      { code: 'CHARCOAL', name: 'Charcoal', kind: 'interior', priceDeltaCents: 0 },
    ],
    options: [
      { code: 'TECH', name: 'Technology Package', category: 'package', description: null, isStandard: false, priceCents: 320_000 },
      { code: 'PERF', name: 'Performance Package', category: 'package', description: null, isStandard: false, priceCents: 450_000 },
      { code: 'TOW', name: 'Towing Package', category: 'utility', description: null, isStandard: false, priceCents: 120_000 },
      { code: 'HEATED', name: 'Heated Seats', category: 'comfort', description: null, isStandard: true, priceCents: 65_000 },
    ],
    rules: [
      { optionCode: 'PERF', rule: 'requires', otherOptionCode: 'TECH' },
      { optionCode: 'PERF', rule: 'excludes', otherOptionCode: 'TOW' },
    ],
    ...overrides,
  };
}

describe('pricing a build', () => {
  it('itemises base, powertrain and trim', () => {
    const result = priceBuild(context(), {});
    expect(result.lines.map((l) => [l.kind, l.amountCents])).toEqual([
      ['base', 5_290_000],
      ['powertrain', 350_000],
      ['trim', 250_000],
    ]);
    expect(result.totalCents).toBe(5_890_000);
    expect(result.totalFormatted).toBe('$58,900');
  });

  it('adds colour surcharges and options', () => {
    const result = priceBuild(context(), {
      exteriorColourCode: 'GLACIER',
      interiorColourCode: 'CHARCOAL',
      optionCodes: ['TECH'],
    });
    expect(result.totalCents).toBe(5_890_000 + 90_000 + 0 + 320_000);
  });

  it('never charges for standard equipment', () => {
    const result = priceBuild(context(), { optionCodes: ['HEATED'] });
    const heated = result.lines.find((l) => l.code === 'HEATED');
    expect(heated).toMatchObject({ amountCents: 0, included: true, formatted: 'Included' });
    expect(result.totalCents).toBe(5_890_000);
  });

  it('is order-independent and ignores duplicates', () => {
    const a = priceBuild(context(), { optionCodes: ['TECH', 'PERF'] });
    const b = priceBuild(context(), { optionCodes: ['PERF', 'TECH', 'TECH'] });
    expect(b.totalCents).toBe(a.totalCents);
    expect(b.lines).toEqual(a.lines);
  });
});

describe('invalid builds', () => {
  it('refuses a configuration that is not offered', () => {
    try {
      priceBuild(context({ configuration: { id: 'c', priceCents: 5_890_000, isOrderable: false } }), {});
      expect.unreachable('should have refused');
    } catch (err) {
      expect(isAppError(err) && err.code).toBe('INVALID_COMBINATION');
      expect((err as Error).message).toContain('not currently offered');
    }
  });

  it('refuses an unavailable colour and says what IS available', () => {
    try {
      priceBuild(context(), { exteriorColourCode: 'MIDNIGHT_GOLD' });
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.code).toBe('INVALID_COMBINATION');
      // The assistant needs the alternatives to offer them, not just a refusal.
      expect(err.data?.available).toEqual([
        { code: 'OBSIDIAN', name: 'Obsidian Black' },
        { code: 'GLACIER', name: 'Glacier Pearl' },
      ]);
    }
  });

  it('refuses an option not offered on this configuration', () => {
    try {
      priceBuild(context(), { optionCodes: ['MASSAGE_SEATS'] });
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.data?.unavailable).toEqual(['MASSAGE_SEATS']);
    }
  });

  it('enforces option dependencies', () => {
    try {
      priceBuild(context(), { optionCodes: ['PERF'] });
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.message).toBe('Performance Package requires Technology Package.');
    }
  });

  it('enforces option exclusions', () => {
    try {
      priceBuild(context(), { optionCodes: ['PERF', 'TECH', 'TOW'] });
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.message).toContain('cannot be combined with');
    }
  });

  it('reports an unknown option before a dependency failure', () => {
    // Misspelling an option should say so, not claim a conflict.
    try {
      priceBuild(context(), { optionCodes: ['PERF', 'TEHC'] });
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.data?.unavailable).toEqual(['TEHC']);
    }
  });
});

describe('data integrity', () => {
  it('refuses to quote when the configuration price and its deltas disagree', () => {
    // Someone edited a powertrain delta without repricing the configuration.
    const broken = context({ trim: { code: 'PREMIUM', name: 'Premium', priceDeltaCents: 999_999 } });
    try {
      priceBuild(broken, {});
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.code).toBe('INTERNAL');
      // The customer is told nothing technical; the detail is for the log.
      expect(err.message).not.toContain('delta');
      expect(err.internal).toMatchObject({ configurationPriceCents: 5_890_000 });
    }
  });

  it('never produces a total below the configuration base price', () => {
    // Property: every line other than base is an adjustment, and no adjustment
    // in the catalogue is negative, so a build can never undercut its own base.
    const ctx = context();
    const allOptions = ctx.options.filter((o) => o.code !== 'TOW').map((o) => o.code);
    for (const codes of [[], ['TECH'], ['HEATED'], allOptions]) {
      const result = priceBuild(ctx, { optionCodes: codes, exteriorColourCode: 'OBSIDIAN' });
      expect.soft(result.totalCents).toBeGreaterThanOrEqual(ctx.configuration.priceCents);
    }
  });
});
