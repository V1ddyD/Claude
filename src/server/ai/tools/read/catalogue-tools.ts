import { z } from 'zod';
import { and, eq, lte, inArray, asc, sql } from 'drizzle-orm';
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
    if (input.maxPriceCents) conditions.push(lte(vehicleModels.baseMsrpCents, input.maxPriceCents));

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

    return ctx.db
      .select()
      .from(vehicleModels)
      .where(and(...conditions))
      .orderBy(asc(vehicleModels.displayOrder))
      .limit(6);
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
    const configurations = await catalogue.listConfigurations(ctx.db, model.id);
    return { model, configurations };
  },
  project: ({ model, configurations }, ctx) => ({
    ...projectModelSummary(model, ctx.tenant),
    overview: model.overview,
    powertrains: [...new Set(configurations.map((c) => c.powertrainName))],
    trims: [...new Set(configurations.map((c) => c.trimName))],
  }),
});

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

    const byTrim = new Map<string, { code: string; name: string; fromPriceCents: number }>();
    for (const c of configurations) {
      const existing = byTrim.get(c.trimCode);
      if (!existing || c.priceCents < existing.fromPriceCents) {
        byTrim.set(c.trimCode, { code: c.trimCode, name: c.trimName, fromPriceCents: c.priceCents });
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
    note: 'Vehicle price only. Excludes taxes, registration and dealer fees.',
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
      .limit(5);

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

    return rows
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
  },
  project: (units, ctx) => ({
    count: units.length,
    available: units.map((u) => ({
      ...projectInventoryUnit(u, ctx.tenant, ctx.now),
      trim: u.trimName,
      powertrain: u.powertrainName,
    })),
  }),
});
