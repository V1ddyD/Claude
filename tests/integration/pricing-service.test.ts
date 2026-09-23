import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prepareDatabase } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import {
  listModels, getModelDetail, calculatePrice, getConfigurationOptions,
} from '../../src/server/services/catalogue';
import { isAppError } from '../../src/server/errors';

/**
 * The full chain: repository -> build context -> pricing engine, against the
 * real seeded catalogue. The unit tests prove the rules; this proves the data
 * actually reaches them in the right shape.
 */

beforeAll(async () => {
  await prepareDatabase();
});
afterAll(async () => {
  await closeConnections();
});

describe('the catalogue through the service layer', () => {
  it('lists the published range', async () => {
    const models = await listModels(SINCLAIR_TENANT_ID);
    expect(models.length).toBeGreaterThanOrEqual(10);
    expect(models.map((m) => m.slug)).toContain('s5');
    // Ordered for presentation, not by insertion.
    expect(models[0]!.slug).toBe('s1');
  });

  it('presents powertrains with the trims they are actually offered with', async () => {
    const { powertrains, trims } = await getModelDetail(SINCLAIR_TENANT_ID, 's5');

    const entry = powertrains.find((p) => p.code === '2.0T-AWD')!;
    expect(entry.offeredWithTrims.sort()).toEqual(['CORE', 'PREMIUM']);
    // The entry engine is deliberately not offered on Luxury.
    expect(entry.offeredWithTrims).not.toContain('LUXURY');

    const six = powertrains.find((p) => p.code === '3.0T-AWD')!;
    expect(six.offeredWithTrims).not.toContain('CORE');

    expect(trims.map((t) => t.code)).toEqual(['CORE', 'PREMIUM', 'LUXURY']);
  });

  it('quotes the demonstration configuration', async () => {
    // The spec §44 scenario: S5, 2.0 Turbo AWD, Premium, Obsidian Black.
    const quote = await calculatePrice(SINCLAIR_TENANT_ID, {
      modelSlug: 's5',
      powertrainCode: '2.0T-AWD',
      trimCode: 'PREMIUM',
      exteriorColourCode: 'OBSIDIAN',
      interiorColourCode: 'CHARCOAL',
    });

    // 52,900 base + 3,500 powertrain + 2,500 trim, Obsidian at no cost.
    expect(quote.totalCents).toBe(5_890_000);
    // Brunei dollars, written as Brunei writes them.
    expect(quote.totalFormatted).toBe('B$58,900');
    expect(quote.summary).toBe('Sinclair S5 · Premium · 2.0 Turbo AWD');
    expect(quote.lines.map((l) => l.kind)).toEqual([
      'base', 'powertrain', 'trim', 'exterior_colour', 'interior_colour',
    ]);
  });

  it('charges for a premium paint and an option', async () => {
    const quote = await calculatePrice(SINCLAIR_TENANT_ID, {
      modelSlug: 's5',
      powertrainCode: '2.0T-AWD',
      trimCode: 'PREMIUM',
      exteriorColourCode: 'GLACIER',
      optionCodes: ['AUDIO'],
    });
    expect(quote.totalCents).toBe(5_890_000 + 90_000 + 180_000);
  });

  it('includes rather than charges an option that is standard on the trim', async () => {
    // TECH is standard on S5 Premium and a paid extra on Core.
    const premium = await calculatePrice(SINCLAIR_TENANT_ID, {
      modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'PREMIUM', optionCodes: ['TECH'],
    });
    expect(premium.lines.find((l) => l.code === 'TECH')).toMatchObject({
      amountCents: 0, included: true,
    });

    const core = await calculatePrice(SINCLAIR_TENANT_ID, {
      modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'CORE', optionCodes: ['TECH'],
    });
    expect(core.lines.find((l) => l.code === 'TECH')!.amountCents).toBe(320_000);
  });

  it('refuses a combination that is not in the matrix', async () => {
    // 2.0 Turbo AWD is not offered on the Luxury trim.
    await expect(
      calculatePrice(SINCLAIR_TENANT_ID, {
        modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'LUXURY',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a colour that does not exist, and says what does', async () => {
    try {
      await calculatePrice(SINCLAIR_TENANT_ID, {
        modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'PREMIUM',
        exteriorColourCode: 'CHARTREUSE',
      });
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.code).toBe('INVALID_COMBINATION');
      const available = err.data?.available as { code: string }[];
      expect(available.map((c) => c.code)).toContain('OBSIDIAN');
    }
  });

  it('enforces a seeded option dependency', async () => {
    // S5: COMFORT requires TECH.
    await expect(
      calculatePrice(SINCLAIR_TENANT_ID, {
        modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'CORE', optionCodes: ['COMFORT'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMBINATION' });
  });

  it('enforces a seeded option exclusion', async () => {
    // S5: TOW excludes PANO.
    await expect(
      calculatePrice(SINCLAIR_TENANT_ID, {
        modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'CORE',
        optionCodes: ['TOW', 'PANO'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMBINATION' });
  });

  it('refuses an unknown model', async () => {
    await expect(
      calculatePrice(SINCLAIR_TENANT_ID, {
        modelSlug: 'z9', powertrainCode: 'X', trimCode: 'Y',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns standard equipment that cumulates up the trim ladder', async () => {
    const core = await getConfigurationOptions(SINCLAIR_TENANT_ID, {
      modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'CORE',
    });
    const premium = await getConfigurationOptions(SINCLAIR_TENANT_ID, {
      modelSlug: 's5', powertrainCode: '2.0T-AWD', trimCode: 'PREMIUM',
    });

    expect(premium.features.length).toBeGreaterThan(core.features.length);
    // Premium keeps everything Core has.
    const coreLabels = core.features.map((f) => f.label);
    const premiumLabels = premium.features.map((f) => f.label);
    expect(coreLabels.every((l) => premiumLabels.includes(l))).toBe(true);
  });

  it('prices every buildable configuration in the catalogue without error', async () => {
    // The real regression guard: a single bad seed row would throw here rather
    // than wait to be discovered by a customer mid-configuration.
    const models = await listModels(SINCLAIR_TENANT_ID);
    let priced = 0;

    for (const model of models) {
      const { configurations } = await getModelDetail(SINCLAIR_TENANT_ID, model.slug);
      for (const config of configurations) {
        const quote = await calculatePrice(SINCLAIR_TENANT_ID, {
          modelSlug: model.slug,
          powertrainCode: config.powertrainCode,
          trimCode: config.trimCode,
        });
        expect.soft(quote.totalCents, `${model.slug} ${config.trimCode}`).toBe(config.priceCents);
        priced++;
      }
    }
    expect(priced).toBeGreaterThanOrEqual(36);
  });
});
