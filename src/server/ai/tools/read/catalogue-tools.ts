import { z } from 'zod';
import { and, eq, inArray, asc, sql } from 'drizzle-orm';
import { defineTool } from '../define';
import {
  vehicleModels, modelConfigurations, powertrains, trims, colours, inventoryUnits,
} from '@/server/db/schema';
import * as catalogue from '@/server/db/repositories/catalogue';
import { priceBuild } from '@/server/services/pricing';
import { notFound } from '@/server/errors';
import {
  projectModelSummary, projectPowertrain, projectTrim, projectInventoryUnit, money,
} from '../projections/catalogue';

/**
 * Read tools.
 *
 * Each is a fixed question. Note what none of them accept: a tenant, a
 * customer, a filter expression, a table name or a row limit above a small cap.
 */

/** The most cars one stock answer lists. */
const STOCK_LIST_LIMIT = 20;

export const searchVehicles = defineTool({
  name: 'searchVehicles',
  scope: 'read',
  summary:
    'Find models matching what a customer described. Use when they say what kind of ' +
    'vehicle they want rather than naming a model. Returns at most six.',
  input: z.object({
    bodyStyle: z.enum(['sedan', 'coupe', 'suv', 'crossover', 'pickup', 'wagon']).optional(),
    maxPriceCents: z.number().int().positive().optional(),
    powertrainKind: z.enum(['ice', 'hybrid', 'phev', 'bev']).optional(),
    drivetrain: z.enum(['fwd', 'rwd', 'awd']).optional(),
  }),
  handler: async (ctx, input) => {
    const conditions = [
      eq(vehicleModels.tenantId, ctx.tenantId),
      eq(vehicleModels.status, 'published'),
    ];
    if (input.bodyStyle) conditions.push(eq(vehicleModels.bodyStyle, input.bodyStyle));
    // Filtered on the cheapest car that can actually be ordered, not the
    // headline MSRP, which can name a combination nobody builds. Otherwise a
    // search under $55,000 lists a car whose cheapest real version is $56,400.
    if (input.maxPriceCents) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${modelConfigurations} mc
          WHERE mc.model_id = ${vehicleModels.id}
            AND mc.price_cents <= ${input.maxPriceCents}
        )`,
      );
    }

    if (input.powertrainKind || input.drivetrain) {
      const ptConditions = [eq(powertrains.tenantId, ctx.tenantId)];
      if (input.powertrainKind) ptConditions.push(eq(powertrains.kind, input.powertrainKind));
      if (input.drivetrain) ptConditions.push(eq(powertrains.drivetrain, input.drivetrain));

      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${powertrains} p
          WHERE p.model_id = ${vehicleModels.id}
            ${input.powertrainKind ? sql`AND p.kind = ${input.powertrainKind}` : sql``}
            ${input.drivetrain ? sql`AND p.drivetrain = ${input.drivetrain}` : sql``}
        )`,
      );
    }

    const models = await ctx.db
      .select()
      .from(vehicleModels)
      .where(and(...conditions))
      .orderBy(asc(vehicleModels.displayOrder))
      .limit(6);

    if (models.length === 0) return models;

    // The same "from" price every other answer quotes: the cheapest
    // configuration, so a search result never disagrees with the car's page.
    const floors = await ctx.db
      .select({
        modelId: modelConfigurations.modelId,
        from: sql<number>`min(${modelConfigurations.priceCents})::bigint`,
      })
      .from(modelConfigurations)
      .where(
        and(
          eq(modelConfigurations.tenantId, ctx.tenantId),
          inArray(modelConfigurations.modelId, models.map((m) => m.id)),
        ),
      )
      .groupBy(modelConfigurations.modelId)
      .limit(6);

    const floor = new Map(floors.map((row) => [row.modelId, Number(row.from)]));
    return models.map((m) => ({ ...m, baseMsrpCents: floor.get(m.id) ?? m.baseMsrpCents }));
  },
  project: (models, ctx) => ({
    count: models.length,
    models: models.map((m) => projectModelSummary(m, ctx.tenant)),
  }),
});

export const getVehicle = defineTool({
  name: 'getVehicle',
  scope: 'read',
  summary:
    'Overview of one model: what it is, what it starts at, and which powertrains and ' +
    'trims exist. Use before answering anything specific about a named model.',
  input: z.object({ modelSlug: z.string().min(1).max(40) }),
  handler: async (ctx, input) => {
    const model = await catalogue.getModelBySlug(ctx.db, input.modelSlug);
    if (!model) throw notFound('That model');

    // Independent reads, issued together: the matrix, the palette sizes and
    // what is on the ground. Everything a first answer about a car should be
    // able to say without a second question.
    const [configurations, palette, inStock] = await Promise.all([
      catalogue.listConfigurations(ctx.db, model.id),
      ctx.db
        .select({ kind: colours.kind, count: sql<number>`count(*)::int` })
        .from(colours)
        .where(and(eq(colours.tenantId, ctx.tenantId), eq(colours.modelId, model.id)))
        .groupBy(colours.kind)
        // Two kinds exist; the cap is the invariant every tool query keeps.
        .limit(2),
      catalogue.countAvailableUnits(ctx.db, model.id),
    ]);
    return { model, configurations, palette, inStock };
  },
  project: ({ model, configurations, palette, inStock }, ctx) => ({
    ...projectModelSummary(model, ctx.tenant),
    // The cheapest car you can actually order, not the headline MSRP.
    //
    // They are not always the same figure: the base engine is often not
    // offered on the base trim, so `baseMsrpCents` can name a combination
    // nobody builds. Quoting it made the overview say "from $52,900" and the
    // trim list say "from $56,400" two messages later, which reads like a
    // bait and switch and is really just two different questions being asked
    // of the same table.
    ...(configurations.length > 0
      ? {
          priceFrom: money(
            Math.min(...configurations.map((c) => c.priceCents)),
            ctx.tenant,
          ),
        }
      : {}),
    ...(configurations.length > 0
      ? {
          priceTo: money(Math.max(...configurations.map((c) => c.priceCents)), ctx.tenant),
        }
      : {}),
    overview: model.overview,
    modelYear: model.modelYear,
    powertrains: [...new Set(configurations.map((c) => c.powertrainName))],
    trims: [...new Set(configurations.map((c) => c.trimName))],
    ...summariseRange(configurations, ctx.tenant),
    colourCounts: {
      exterior: palette.find((row) => row.kind === 'exterior')?.count ?? 0,
      interior: palette.find((row) => row.kind === 'interior')?.count ?? 0,
    },
    // How many are on the ground now. A count, not a promise: the stock tool
    // is what names an actual car.
    inStock,
  }),
});

/**
 * The shape of a model's range, as a customer would summarise it.
 *
 * Every figure is a minimum or maximum over rows the dealership entered; a
 * field with no data in any row comes back null rather than zero, so the
 * assistant says nothing about it instead of saying something false.
 */
function summariseRange(
  configurations: Awaited<ReturnType<typeof catalogue.listConfigurations>>,
  tenant: { currency: string; locale: string },
) {
  const engines = new Map<string, (typeof configurations)[number]>();
  for (const c of configurations) if (!engines.has(c.powertrainCode)) engines.set(c.powertrainCode, c);
  const rows = [...engines.values()];

  const power = rows.map((r) => r.horsepower ?? 0).filter((hp) => hp > 0);
  const fuel = rows
    .map((r) => Number(r.consumptionL100))
    .filter((value) => Number.isFinite(value) && value > 0);
  const range = rows.map((r) => r.rangeKm ?? 0).filter((km) => km > 0);

  const trims = new Map<string, { name: string; fromCents: number; summary: string | null }>();
  for (const c of configurations) {
    const seen = trims.get(c.trimCode);
    if (!seen || c.priceCents < seen.fromCents) {
      trims.set(c.trimCode, { name: c.trimName, fromCents: c.priceCents, summary: c.trimSummary });
    }
  }

  return {
    horsepower: power.length ? { min: Math.min(...power), max: Math.max(...power) } : null,
    drivetrains: [...new Set(rows.map((r) => r.drivetrain.toUpperCase()))],
    powertrainKinds: [...new Set(rows.map((r) => r.powertrainKind))],
    transmissions: [...new Set(rows.map((r) => r.transmission).filter((t): t is string => Boolean(t)))],
    bestFuelL100: fuel.length ? Math.min(...fuel) : null,
    bestElectricRangeKm: range.length ? Math.max(...range) : null,
    engines: rows.map((r) => ({
      name: r.powertrainName,
      type: r.powertrainKind,
      horsepower: r.horsepower,
    })),
    trimDetails: [...trims.values()].map((trim) => ({
      name: trim.name,
      priceFrom: money(trim.fromCents, tenant),
      summary: trim.summary,
    })),
  };
}

export const getVehiclePowertrains = defineTool({
  name: 'getVehiclePowertrains',
  scope: 'read',
  summary:
    'Engines and motors available for a model, with output, drivetrain and which trims ' +
    'each is offered with. Not every powertrain is offered with every trim.',
  input: z.object({ modelSlug: z.string().min(1).max(40) }),
  handler: async (ctx, input) => {
    const detail = await catalogue.getModelBySlug(ctx.db, input.modelSlug);
    if (!detail) throw notFound('That model');
    const configurations = await catalogue.listConfigurations(ctx.db, detail.id);

    const byCode = new Map<string, ReturnType<typeof toEntry>>();
    function toEntry(c: (typeof configurations)[number]) {
      return {
        code: c.powertrainCode, name: c.powertrainName, kind: c.powertrainKind,
        drivetrain: c.drivetrain, horsepower: c.horsepower, rangeKm: c.rangeKm,
        engineDesc: c.engineDesc, motorDesc: c.motorDesc, transmission: c.transmission,
        torqueNm: c.torqueNm, batteryKwh: c.batteryKwh,
        consumptionL100: c.consumptionL100, consumptionLe: c.consumptionLe,
        offeredWithTrims: [] as string[],
      };
    }
    for (const c of configurations) {
      const entry = byCode.get(c.powertrainCode) ?? toEntry(c);
      entry.offeredWithTrims.push(c.trimCode);
      byCode.set(c.powertrainCode, entry);
    }
    return [...byCode.values()];
  },
  project: (list) => ({ powertrains: list.map(projectPowertrain) }),
});

export const getVehicleTrims = defineTool({
  name: 'getVehicleTrims',
  scope: 'read',
  summary: 'Trim levels for a model with the price each starts at.',
  input: z.object({
    modelSlug: z.string().min(1).max(40),
    powertrainCode: z.string().max(40).optional(),
  }),
  handler: async (ctx, input) => {
    const model = await catalogue.getModelBySlug(ctx.db, input.modelSlug);
    if (!model) throw notFound('That model');

    const configurations = (await catalogue.listConfigurations(ctx.db, model.id)).filter(
      (c) => !input.powertrainCode || c.powertrainCode === input.powertrainCode,
    );

    const byTrim = new Map<
      string,
      { code: string; name: string; fromPriceCents: number; summary: string | null }
    >();
    for (const c of configurations) {
      const existing = byTrim.get(c.trimCode);
      if (!existing || c.priceCents < existing.fromPriceCents) {
        byTrim.set(c.trimCode, {
          code: c.trimCode, name: c.trimName, fromPriceCents: c.priceCents,
          summary: c.trimSummary,
        });
      }
    }
    return [...byTrim.values()];
  },
  project: (list, ctx) => ({ trims: list.map((t) => projectTrim(t, ctx.tenant)) }),
});

export const getVehicleColours = defineTool({
  name: 'getVehicleColours',
  scope: 'read',
  summary: 'Exterior and interior colours offered on a model, with any surcharge.',
  input: z.object({
    modelSlug: z.string().min(1).max(40),
    kind: z.enum(['exterior', 'interior']).optional(),
  }),
  handler: async (ctx, input) => {
    const model = await catalogue.getModelBySlug(ctx.db, input.modelSlug);
    if (!model) throw notFound('That model');

    const conditions = [eq(colours.tenantId, ctx.tenantId), eq(colours.modelId, model.id)];
    if (input.kind) conditions.push(eq(colours.kind, input.kind));

    return ctx.db
      .select({
        code: colours.code, name: colours.name, kind: colours.kind,
        finish: colours.finish, material: colours.material,
        priceDeltaCents: colours.priceDeltaCents,
      })
      .from(colours)
      .where(and(...conditions))
      .orderBy(asc(colours.displayOrder))
      .limit(30);
  },
  project: (list, ctx) => ({
    colours: list.map((c) => ({
      code: c.code, name: c.name, kind: c.kind,
      finish: c.finish ?? c.material,
      surcharge: c.priceDeltaCents === 0 ? null : money(c.priceDeltaCents, ctx.tenant),
    })),
  }),
});

export const calculateVehiclePrice = defineTool({
  name: 'calculateVehiclePrice',
  scope: 'read',
  summary:
    'Price a specific build. Validates that the combination is actually offered; if it ' +
    'is not, the error names what IS offered. Always use this rather than adding prices up.',
  input: z.object({
    modelSlug: z.string().min(1).max(40),
    powertrainCode: z.string().min(1).max(40),
    trimCode: z.string().min(1).max(40),
    exteriorColourCode: z.string().max(40).optional(),
    interiorColourCode: z.string().max(40).optional(),
    optionCodes: z.array(z.string().max(40)).max(20).optional(),
  }),
  handler: async (ctx, input) => {
    const context = await catalogue.getBuildContext(
      ctx.db,
      {
        modelSlug: input.modelSlug,
        powertrainCode: input.powertrainCode,
        trimCode: input.trimCode,
      },
      { currency: ctx.tenant.currency, locale: ctx.tenant.locale },
    );
    if (!context) throw notFound('That combination');
    return priceBuild(context, input);
  },
  project: (breakdown) => ({
    summary: breakdown.summary,
    lines: breakdown.lines.map((l) => ({
      label: l.label,
      amount: l.included ? 'Included' : l.formatted,
    })),
    total: { formatted: breakdown.totalFormatted, cents: breakdown.totalCents },
    note: 'Vehicle price only. On-the-road costs such as registration and insurance are extra.',
  }),
});

export const checkInventory = defineTool({
  name: 'checkInventory',
  scope: 'read',
  summary:
    'Cars physically available now. Never promise a specific vehicle without calling ' +
    'this first — availability changes and a sold car must never be offered.',
  input: z.object({
    modelSlug: z.string().min(1).max(40),
    trimCode: z.string().max(40).optional(),
    exteriorColourCode: z.string().max(40).optional(),
  }),
  handler: async (ctx, input) => {
    const conditions = [
      eq(vehicleModels.tenantId, ctx.tenantId),
      eq(vehicleModels.slug, input.modelSlug),
      // The public view, never the table: a sold car cannot appear here even
      // if a predicate below is wrong.
      eq(inventoryUnits.status, 'available'),
    ];
    if (input.trimCode) conditions.push(eq(trims.code, input.trimCode));

    const rows = await ctx.db
      .select({
        stockNumber: inventoryUnits.stockNumber,
        askingPriceCents: inventoryUnits.askingPriceCents,
        estimatedDeliveryOn: inventoryUnits.estimatedDeliveryOn,
        condition: inventoryUnits.condition,
        trimName: trims.name,
        powertrainName: powertrains.name,
        exteriorColourId: inventoryUnits.exteriorColourId,
        interiorColourId: inventoryUnits.interiorColourId,
      })
      .from(inventoryUnits)
      .innerJoin(modelConfigurations, eq(modelConfigurations.id, inventoryUnits.modelConfigurationId))
      .innerJoin(vehicleModels, eq(vehicleModels.id, modelConfigurations.modelId))
      .innerJoin(trims, eq(trims.id, modelConfigurations.trimId))
      .innerJoin(powertrains, eq(powertrains.id, modelConfigurations.powertrainId))
      .where(and(...conditions))
      // Enough to show a model's whole stock when the customer asks for all
      // of it, and still a bounded read.
      .limit(STOCK_LIST_LIMIT);

    const colourIds = rows
      .flatMap((r) => [r.exteriorColourId, r.interiorColourId])
      .filter((id): id is string => Boolean(id));

    const colourNames = colourIds.length
      ? new Map(
          (
            await ctx.db
              .select({ id: colours.id, name: colours.name, code: colours.code })
              .from(colours)
              .where(and(eq(colours.tenantId, ctx.tenantId), inArray(colours.id, colourIds)))
          ).map((c) => [c.id, c]),
        )
      : new Map();

    const units = rows
      .filter(
        (r) =>
          !input.exteriorColourCode ||
          colourNames.get(r.exteriorColourId ?? '')?.code === input.exteriorColourCode,
      )
      .map((r) => ({
        ...r,
        exteriorColour: colourNames.get(r.exteriorColourId ?? '')?.name ?? null,
        interiorColour: colourNames.get(r.interiorColourId ?? '')?.name ?? null,
      }));

    // At most STOCK_LIST_LIMIT cars are returned, so a count of the rows is
    // wrong for any model with more. The total is counted separately so the headline is
    // true even when the list is a sample. Not counted when a colour filter
    // applies after the fact: the list is the whole answer then.
    const total = input.exteriorColourCode
      ? units.length
      : Number(
          (
            await ctx.db
              .select({ count: sql<number>`count(*)::int` })
              .from(inventoryUnits)
              .innerJoin(modelConfigurations, eq(modelConfigurations.id, inventoryUnits.modelConfigurationId))
              .innerJoin(vehicleModels, eq(vehicleModels.id, modelConfigurations.modelId))
              .innerJoin(trims, eq(trims.id, modelConfigurations.trimId))
              .where(and(...conditions))
          )[0]?.count ?? units.length,
        );

    return { units, total: Math.max(total, units.length) };
  },
  project: ({ units, total }, ctx) => ({
    count: units.length,
    total,
    available: units.map((u) => ({
      ...projectInventoryUnit(u, ctx.tenant, ctx.now),
      trim: u.trimName,
      powertrain: u.powertrainName,
    })),
  }),
});
