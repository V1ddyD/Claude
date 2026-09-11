import 'server-only';
import { withTenant } from '@/server/db/tenant-db';
import { getTenantById } from '@/server/context/tenant';
import * as catalogue from '@/server/db/repositories/catalogue';
import { priceBuild, type PriceBreakdown, type BuildSelection } from '@/server/services/pricing';
import { notFound } from '@/server/errors';

/**
 * Catalogue and pricing use cases.
 *
 * This is the single entry point for anything that needs to know what Sinclair
 * sells or what it costs — the website, the configurator, the Dealer Portal and
 * the AI assistant all come through here, so they cannot disagree.
 */

export async function listModels(tenantId: string) {
  return withTenant(tenantId, (db) => catalogue.listModels(db));
}

export async function getModelDetail(tenantId: string, slug: string) {
  return withTenant(tenantId, async (db) => {
    const model = await catalogue.getModelBySlug(db, slug);
    if (!model) throw notFound('That model');

    const configurations = await catalogue.listConfigurations(db, model.id);

    // Powertrains and trims presented from the matrix rather than listed
    // independently, so the page can never offer a combination that is not built.
    const powertrains = dedupeBy(configurations, (c) => c.powertrainCode).map((c) => ({
      code: c.powertrainCode,
      name: c.powertrainName,
      kind: c.powertrainKind,
      drivetrain: c.drivetrain,
      horsepower: c.horsepower,
      rangeKm: c.rangeKm,
      offeredWithTrims: configurations
        .filter((other) => other.powertrainCode === c.powertrainCode)
        .map((other) => other.trimCode),
    }));

    const trims = dedupeBy(configurations, (c) => c.trimCode).map((c) => ({
      code: c.trimCode,
      name: c.trimName,
      tierOrder: c.tierOrder,
      fromPriceCents: Math.min(
        ...configurations.filter((o) => o.trimCode === c.trimCode).map((o) => o.priceCents),
      ),
    }));

    return { model, configurations, powertrains, trims };
  });
}

export interface PriceRequest extends BuildSelection {
  modelSlug: string;
  powertrainCode: string;
  trimCode: string;
}

export async function calculatePrice(
  tenantId: string,
  request: PriceRequest,
): Promise<PriceBreakdown> {
  const tenant = await getTenantById(tenantId);

  return withTenant(tenantId, async (db) => {
    const context = await catalogue.getBuildContext(
      db,
      {
        modelSlug: request.modelSlug,
        powertrainCode: request.powertrainCode,
        trimCode: request.trimCode,
      },
      { currency: tenant.currency, locale: tenant.locale },
    );

    // Not in the matrix at all is a different answer from "exists but is not
    // orderable", which priceBuild reports with the trim and powertrain named.
    if (!context) throw notFound('That combination');

    return priceBuild(context, request);
  });
}

/** Everything buildable for a configuration: colours, options and their rules. */
export async function getConfigurationOptions(
  tenantId: string,
  params: { modelSlug: string; powertrainCode: string; trimCode: string },
) {
  const tenant = await getTenantById(tenantId);

  return withTenant(tenantId, async (db) => {
    const context = await catalogue.getBuildContext(db, params, {
      currency: tenant.currency,
      locale: tenant.locale,
    });
    if (!context) throw notFound('That combination');

    const features = await catalogue.listFeatures(db, context.configuration.id);

    return {
      configurationId: context.configuration.id,
      basePriceCents: context.configuration.priceCents,
      exteriorColours: context.exteriorColours,
      interiorColours: context.interiorColours,
      options: context.options,
      rules: context.rules,
      features,
    };
  });
}

function dedupeBy<T, K>(items: T[], key: (item: T) => K): T[] {
  const seen = new Set<K>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
