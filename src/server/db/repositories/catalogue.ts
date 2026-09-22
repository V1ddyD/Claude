import 'server-only';
import { and, eq, asc, sql } from 'drizzle-orm';
import type { TenantDb } from '@/server/db/tenant-db';
import {
  vehicleModels, powertrains, trims, modelConfigurations, colours, inventoryUnits,
  colourAvailability, options, optionAvailability, optionRules, vehicleFeatures,
} from '@/server/db/schema';
import type { BuildContext } from '@/server/services/pricing';

/**
 * Catalogue reads.
 *
 * Every query carries an explicit tenant predicate even though RLS already
 * enforces one. That is deliberate duplication: the predicate documents intent
 * at the call site and keeps the query correct if it is ever run through a
 * connection whose context was not established. Defence in depth means both
 * layers hold on their own.
 */

export interface ModelSummary {
  id: string;
  slug: string;
  name: string;
  fullName: string;
  modelYear: number;
  bodyStyle: string;
  segment: string;
  tagline: string | null;
  baseMsrpCents: number;
  heroImageUrl: string | null;
  /** 'ice' | 'hybrid' | 'phev' | 'bev', as offered across this model's builds. */
  powertrainKinds: string[];
  /** Units on the floor today. Zero is an answer, not a missing value. */
  inStock: number;
}

export async function listModels(db: TenantDb): Promise<ModelSummary[]> {
  return db
    .select({
      id: vehicleModels.id,
      slug: vehicleModels.slug,
      name: vehicleModels.name,
      fullName: vehicleModels.fullName,
      modelYear: vehicleModels.modelYear,
      bodyStyle: vehicleModels.bodyStyle,
      segment: vehicleModels.segment,
      tagline: vehicleModels.tagline,
      baseMsrpCents: vehicleModels.baseMsrpCents,
      heroImageUrl: vehicleModels.heroImageUrl,

      // What a customer scanning the range wants to know before clicking:
      // what it runs on, and whether one is on the floor today.
      //
      // Correlated subqueries rather than joins — joining the configuration
      // matrix would multiply the row per trim and powertrain, and counting
      // stock in a second pass would be a second round trip for a number that
      // belongs on the card.
      //
      // The outer columns are written out as `vehicle_models.tenant_id` rather
      // than interpolated. Interpolating renders them bare here, and a bare
      // `tenant_id` inside a subquery that has joined two more tenant-scoped
      // tables is ambiguous — Postgres refuses the query, which is the good
      // outcome; the bad one is a bare `id` quietly binding to the SUBQUERY's
      // row and correlating a model to itself.
      powertrainKinds: sql<string[]>`(
        SELECT coalesce(array_agg(DISTINCT p.kind ORDER BY p.kind), '{}'::text[])
        FROM model_configurations mc
        JOIN powertrains p ON p.id = mc.powertrain_id
        WHERE mc.tenant_id = vehicle_models.tenant_id
          AND mc.model_id = vehicle_models.id
      )`,
      inStock: sql<number>`(
        SELECT count(*)::int
        FROM inventory_units iu
        JOIN model_configurations mc ON mc.id = iu.model_configuration_id
        WHERE iu.tenant_id = vehicle_models.tenant_id
          AND mc.model_id = vehicle_models.id
          AND iu.status = 'available'
      )`,
    })
    .from(vehicleModels)
    .where(and(eq(vehicleModels.tenantId, db.tenantId), eq(vehicleModels.status, 'published')))
    .orderBy(asc(vehicleModels.displayOrder), asc(vehicleModels.name));
}

/** Units of this model on the floor today. Zero is an answer, not an absence. */
export async function countAvailableUnits(db: TenantDb, modelId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inventoryUnits)
    .innerJoin(modelConfigurations, eq(modelConfigurations.id, inventoryUnits.modelConfigurationId))
    .where(
      and(
        eq(inventoryUnits.tenantId, db.tenantId),
        eq(modelConfigurations.modelId, modelId),
        eq(inventoryUnits.status, 'available'),
      ),
    );
  return rows[0]?.count ?? 0;
}

export async function getModelBySlug(db: TenantDb, slug: string) {
  const rows = await db
    .select()
    .from(vehicleModels)
    .where(
      and(
        eq(vehicleModels.tenantId, db.tenantId),
        eq(vehicleModels.slug, slug),
        eq(vehicleModels.status, 'published'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Every offered powertrain x trim combination for a model, with its price. */
export async function listConfigurations(db: TenantDb, modelId: string) {
  return db
    .select({
      id: modelConfigurations.id,
      priceCents: modelConfigurations.priceCents,
      isOrderable: modelConfigurations.isOrderable,
      powertrainCode: powertrains.code,
      powertrainName: powertrains.name,
      powertrainKind: powertrains.kind,
      drivetrain: powertrains.drivetrain,
      horsepower: powertrains.horsepower,
      rangeKm: powertrains.rangeKm,
      engineDesc: powertrains.engineDesc,
      motorDesc: powertrains.motorDesc,
      transmission: powertrains.transmission,
      torqueNm: powertrains.torqueNm,
      batteryKwh: powertrains.batteryKwh,
      consumptionL100: powertrains.consumptionL100,
      consumptionLe: powertrains.consumptionLe,
      trimCode: trims.code,
      trimName: trims.name,
      trimSummary: trims.summary,
      tierOrder: trims.tierOrder,
    })
    .from(modelConfigurations)
    .innerJoin(powertrains, eq(powertrains.id, modelConfigurations.powertrainId))
    .innerJoin(trims, eq(trims.id, modelConfigurations.trimId))
    .where(and(eq(modelConfigurations.tenantId, db.tenantId), eq(modelConfigurations.modelId, modelId)))
    .orderBy(asc(trims.tierOrder), asc(powertrains.displayOrder));
}

export async function listFeatures(db: TenantDb, configurationId: string) {
  return db
    .select({
      category: vehicleFeatures.category,
      label: vehicleFeatures.label,
    })
    .from(vehicleFeatures)
    .where(
      and(
        eq(vehicleFeatures.tenantId, db.tenantId),
        eq(vehicleFeatures.modelConfigurationId, configurationId),
      ),
    )
    .orderBy(asc(vehicleFeatures.category), asc(vehicleFeatures.displayOrder));
}

/**
 * Assemble everything needed to price one configuration.
 *
 * Returns null when the combination is not in the matrix at all — which is a
 * different answer from "exists but not orderable", and the caller says so
 * differently.
 */
export async function getBuildContext(
  db: TenantDb,
  params: { modelSlug: string; powertrainCode: string; trimCode: string },
  tenant: { currency: string; locale: string },
): Promise<BuildContext | null> {
  const rows = await db
    .select({
      modelId: vehicleModels.id,
      modelSlug: vehicleModels.slug,
      modelName: vehicleModels.name,
      modelFullName: vehicleModels.fullName,
      baseMsrpCents: vehicleModels.baseMsrpCents,
      powertrainCode: powertrains.code,
      powertrainName: powertrains.name,
      powertrainDelta: powertrains.priceDeltaCents,
      trimCode: trims.code,
      trimName: trims.name,
      trimDelta: trims.priceDeltaCents,
      configurationId: modelConfigurations.id,
      configurationPrice: modelConfigurations.priceCents,
      isOrderable: modelConfigurations.isOrderable,
    })
    .from(modelConfigurations)
    .innerJoin(vehicleModels, eq(vehicleModels.id, modelConfigurations.modelId))
    .innerJoin(powertrains, eq(powertrains.id, modelConfigurations.powertrainId))
    .innerJoin(trims, eq(trims.id, modelConfigurations.trimId))
    .where(
      and(
        eq(modelConfigurations.tenantId, db.tenantId),
        eq(vehicleModels.slug, params.modelSlug),
        eq(vehicleModels.status, 'published'),
        eq(powertrains.code, params.powertrainCode),
        eq(trims.code, params.trimCode),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const [exterior, interior, availableOptions, rules] = await Promise.all([
    listColoursFor(db, row.modelId, row.configurationId, 'exterior'),
    listColoursFor(db, row.modelId, row.configurationId, 'interior'),
    listOptionsFor(db, row.configurationId),
    listRulesFor(db, row.modelId),
  ]);

  return {
    currency: tenant.currency,
    locale: tenant.locale,
    model: {
      slug: row.modelSlug,
      name: row.modelName,
      fullName: row.modelFullName,
      baseMsrpCents: row.baseMsrpCents,
    },
    powertrain: {
      code: row.powertrainCode,
      name: row.powertrainName,
      priceDeltaCents: row.powertrainDelta,
    },
    trim: { code: row.trimCode, name: row.trimName, priceDeltaCents: row.trimDelta },
    configuration: {
      id: row.configurationId,
      priceCents: row.configurationPrice,
      isOrderable: row.isOrderable,
    },
    exteriorColours: exterior,
    interiorColours: interior,
    options: availableOptions,
    rules,
  };
}

/**
 * A colour with no availability rows is offered on every configuration; one
 * with rows is restricted to exactly those. Absence means "unrestricted", not
 * "unavailable" — otherwise every colour would need a row per configuration.
 */
async function listColoursFor(
  db: TenantDb,
  modelId: string,
  configurationId: string,
  kind: 'exterior' | 'interior',
) {
  const rows = await db
    .select({
      code: colours.code,
      name: colours.name,
      priceDeltaCents: colours.priceDeltaCents,
    })
    .from(colours)
    .where(
      and(
        eq(colours.tenantId, db.tenantId),
        eq(colours.modelId, modelId),
        eq(colours.kind, kind),
        sql`(
          NOT EXISTS (
            SELECT 1 FROM ${colourAvailability} ca WHERE ca.colour_id = ${colours.id}
          )
          OR EXISTS (
            SELECT 1 FROM ${colourAvailability} ca
            WHERE ca.colour_id = ${colours.id}
              AND ca.model_configuration_id = ${configurationId}
          )
        )`,
      ),
    )
    .orderBy(asc(colours.displayOrder), asc(colours.name));

  return rows.map((r) => ({ ...r, kind }));
}

/** Options require an explicit availability row: absence means not offered. */
async function listOptionsFor(db: TenantDb, configurationId: string) {
  const rows = await db
    .select({
      code: options.code,
      name: options.name,
      category: options.category,
      description: options.description,
      isStandard: optionAvailability.isStandard,
      listPriceCents: options.priceCents,
      overrideCents: optionAvailability.priceOverrideCents,
    })
    .from(optionAvailability)
    .innerJoin(options, eq(options.id, optionAvailability.optionId))
    .where(
      and(
        eq(optionAvailability.tenantId, db.tenantId),
        eq(optionAvailability.modelConfigurationId, configurationId),
      ),
    )
    .orderBy(asc(options.category), asc(options.name));

  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    category: r.category,
    description: r.description,
    isStandard: r.isStandard,
    priceCents: r.overrideCents ?? r.listPriceCents,
  }));
}

async function listRulesFor(db: TenantDb, modelId: string) {
  const self = options;
  const other = { ...options };

  const rows = await db
    .select({
      optionCode: self.code,
      rule: optionRules.rule,
      otherOptionId: optionRules.otherOptionId,
    })
    .from(optionRules)
    .innerJoin(self, eq(self.id, optionRules.optionId))
    .where(and(eq(optionRules.tenantId, db.tenantId), eq(self.modelId, modelId)));

  if (rows.length === 0) return [];

  // Second pass for the other side of each rule: a self-join on the same table
  // needs an alias, and one extra small query is clearer than building one.
  const codesById = new Map(
    (
      await db
        .select({ id: other.id, code: other.code })
        .from(options)
        .where(and(eq(options.tenantId, db.tenantId), eq(options.modelId, modelId)))
    ).map((o) => [o.id, o.code]),
  );

  return rows.map((r) => ({
    optionCode: r.optionCode,
    rule: r.rule,
    otherOptionCode: codesById.get(r.otherOptionId) ?? r.otherOptionId,
  }));
}
