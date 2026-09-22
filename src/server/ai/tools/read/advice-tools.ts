import { z } from 'zod';
import { and, eq, asc } from 'drizzle-orm';
import { defineTool } from '../define';
import {
  modelConfigurations, powertrains, trims,
  businessHours, businessClosures, tenantSettings,
} from '@/server/db/schema';
import * as catalogue from '@/server/db/repositories/catalogue';
import { calculateFinanceEstimate } from '@/server/services/finance';
import { notFound, AppError } from '@/server/errors';
import { money } from '../projections/catalogue';

/**
 * Tools for the parts of a conversation that are not "look this up": comparing,
 * budgeting, and knowing where the dealership is and when it is open.
 */

export const getVehicleOptions = defineTool({
  name: 'getVehicleOptions',
  scope: 'read',
  summary:
    'Options and packages for a specific model, trim and powertrain, marked as standard ' +
    'or optional with their price. Use before discussing what a build includes — an ' +
    'option standard on one trim is a paid extra on another.',
  input: z.object({
    modelSlug: z.string().min(1).max(40),
    trimCode: z.string().min(1).max(40),
    powertrainCode: z.string().min(1).max(40),
  }),
  handler: async (ctx, input) => {
    const context = await catalogue.getBuildContext(
      ctx.db,
      input,
      { currency: ctx.tenant.currency, locale: ctx.tenant.locale },
    );
    if (!context) throw notFound('That combination');
    return context;
  },
  project: (context, ctx) => ({
    options: context.options.map((option) => ({
      code: option.code,
      name: option.name,
      category: option.category,
      // What the pack actually contains. Written by the dealership; it was
      // being selected out of the query and never shown to anyone.
      description: option.description ?? null,
      included: option.isStandard,
      price: option.isStandard ? null : money(option.priceCents, ctx.tenant),
    })),
    // Given to the model so it can warn before a customer picks an impossible
    // pair, rather than letting the price tool refuse after the fact.
    rules: context.rules.map((r) => `${r.optionCode} ${r.rule} ${r.otherOptionCode}`),
  }),
});

export const compareVehicles = defineTool({
  name: 'compareVehicles',
  scope: 'read',
  summary:
    'Compare two or three models side by side on price, power, drivetrain, range and ' +
    'economy. Use when a customer is choosing between them.',
  input: z.object({
    modelSlugs: z.array(z.string().min(1).max(40)).min(2).max(3),
  }),
  handler: async (ctx, input) => {
    const results = [];

    for (const slug of input.modelSlugs) {
      const model = await catalogue.getModelBySlug(ctx.db, slug);
      if (!model) throw notFound(`The model "${slug}"`);

      const configurations = await ctx.db
        .select({
          priceCents: modelConfigurations.priceCents,
          powertrainName: powertrains.name,
          kind: powertrains.kind,
          drivetrain: powertrains.drivetrain,
          horsepower: powertrains.horsepower,
          rangeKm: powertrains.rangeKm,
          consumptionL100: powertrains.consumptionL100,
          trimName: trims.name,
        })
        .from(modelConfigurations)
        .innerJoin(powertrains, eq(powertrains.id, modelConfigurations.powertrainId))
        .innerJoin(trims, eq(trims.id, modelConfigurations.trimId))
        .where(
          and(
            eq(modelConfigurations.tenantId, ctx.tenantId),
            eq(modelConfigurations.modelId, model.id),
          ),
        )
        .limit(20);

      results.push({ model, configurations });
    }
    return results;
  },
  project: (results, ctx) =>
    results.map(({ model, configurations }) => ({
      name: model.fullName,
      slug: model.slug,
      segment: model.segment,
      bodyStyle: model.bodyStyle,
      priceFrom: money(Math.min(...configurations.map((c) => c.priceCents)), ctx.tenant),
      priceTo: money(Math.max(...configurations.map((c) => c.priceCents)), ctx.tenant),
      maxHorsepower: Math.max(...configurations.map((c) => c.horsepower ?? 0)) || null,
      drivetrains: [...new Set(configurations.map((c) => c.drivetrain.toUpperCase()))],
      powertrainTypes: [...new Set(configurations.map((c) => c.kind))],
      bestElectricRangeKm: Math.max(...configurations.map((c) => c.rangeKm ?? 0)) || null,
      bestConsumptionL100: Math.min(
        ...configurations.map((c) => Number(c.consumptionL100) || Infinity),
      ) === Infinity
        ? null
        : Math.min(...configurations.map((c) => Number(c.consumptionL100) || Infinity)),
      trims: [...new Set(configurations.map((c) => c.trimName))],
    })),
});

export const calculateFinanceEstimateTool = defineTool({
  name: 'calculateFinanceEstimate',
  scope: 'read',
  summary:
    'Estimate a monthly payment. Always present the result as an estimate and repeat the ' +
    'disclaimer it returns. Never describe it as an offer, a rate, or an approval.',
  input: z.object({
    vehiclePriceCents: z.number().int().positive(),
    downPaymentCents: z.number().int().min(0).optional(),
    tradeInValueCents: z.number().int().min(0).optional(),
    termMonths: z.number().int().min(12).max(96),
    /** Omitted uses the dealership's advertised rate. */
    aprBps: z.number().int().min(0).max(3000).optional(),
  }),
  handler: async (ctx, input) => {
    const settings = await ctx.db
      .select({ finance: tenantSettings.finance })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, ctx.tenantId))
      .limit(1);

    const configured = (settings[0]?.finance ?? {}) as { defaultAprBps?: number };
    const aprBps = input.aprBps ?? configured.defaultAprBps;

    // No invented rate. If the dealership has not configured one and the
    // customer has not given one, say so rather than guessing (spec §8).
    if (aprBps === undefined) {
      throw new AppError(
        'VALIDATION_FAILED',
        'I need an interest rate to estimate a payment. A specialist can confirm the current rate.',
      );
    }

    return calculateFinanceEstimate(
      { ...input, aprBps },
      { currency: ctx.tenant.currency, locale: ctx.tenant.locale },
    );
  },
  project: (estimate) => ({
    monthlyPayment: estimate.formatted.monthlyPayment,
    amountFinanced: estimate.formatted.amountFinanced,
    totalOfPayments: estimate.formatted.totalOfPayments,
    totalInterest: estimate.formatted.totalInterest,
    termMonths: estimate.termMonths,
    aprPercent: estimate.aprPercent,
    isEstimate: true,
    disclaimer: estimate.disclaimer,
  }),
});

export const getDealershipInformation = defineTool({
  name: 'getDealershipInformation',
  scope: 'read',
  summary: 'Where the dealership is, how to reach it, and how quickly the team responds.',
  input: z.object({}),
  handler: async (ctx) => {
    const rows = await ctx.db
      .select({ contact: tenantSettings.contact, booking: tenantSettings.booking })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, ctx.tenantId))
      .limit(1);
    return rows[0] ?? { contact: {}, booking: {} };
  },
  project: (settings, ctx) => {
    const contact = settings.contact as Record<string, string>;
    const booking = settings.booking as { responseSlaHours?: Record<string, number> };
    return {
      name: ctx.tenant.brandName,
      phone: contact.phone ?? null,
      email: contact.email ?? null,
      address: [contact.addressLine1, contact.city, contact.region, contact.postalCode]
        .filter(Boolean)
        .join(', ') || null,
      timezone: ctx.tenant.timezone,
      salesResponseHours: booking.responseSlaHours?.sales ?? null,
    };
  },
});

export const getDealershipHours = defineTool({
  name: 'getDealershipHours',
  scope: 'read',
  summary: 'Opening hours and any upcoming closures, in the dealership\'s local time.',
  input: z.object({ department: z.enum(['sales', 'service']).optional() }),
  handler: async (ctx, input) => {
    const department = input.department ?? 'sales';

    const [hours, closures] = await Promise.all([
      ctx.db
        .select({
          dayOfWeek: businessHours.dayOfWeek,
          opensAt: businessHours.opensAt,
          closesAt: businessHours.closesAt,
        })
        .from(businessHours)
        .where(
          and(eq(businessHours.tenantId, ctx.tenantId), eq(businessHours.department, department)),
        )
        .orderBy(asc(businessHours.dayOfWeek)),
      ctx.db
        .select({
          startsOn: businessClosures.startsOn,
          endsOn: businessClosures.endsOn,
          reason: businessClosures.reason,
        })
        .from(businessClosures)
        .where(eq(businessClosures.tenantId, ctx.tenantId))
        .limit(10),
    ]);

    return { department, hours, closures };
  },
  project: ({ department, hours, closures }, ctx) => {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const open = new Map(hours.map((h) => [h.dayOfWeek, h]));

    return {
      department,
      timezone: ctx.tenant.timezone,
      hours: days.map((name, index) => {
        const entry = open.get(index);
        return {
          day: name,
          // "Closed" stated explicitly: an absent row is a fact, not a gap.
          opens: entry ? entry.opensAt.slice(0, 5) : null,
          closes: entry ? entry.closesAt.slice(0, 5) : null,
          closed: !entry,
        };
      }),
      upcomingClosures: closures,
    };
  },
});

export const getVehicleFeatures = defineTool({
  name: 'getVehicleFeatures',
  scope: 'read',
  summary: 'Standard equipment on a specific trim, grouped by category.',
  input: z.object({
    modelSlug: z.string().min(1).max(40),
    trimCode: z.string().min(1).max(40),
    powertrainCode: z.string().min(1).max(40),
  }),
  handler: async (ctx, input) => {
    const context = await catalogue.getBuildContext(ctx.db, input, {
      currency: ctx.tenant.currency,
      locale: ctx.tenant.locale,
    });
    if (!context) throw notFound('That combination');
    return catalogue.listFeatures(ctx.db, context.configuration.id);
  },
  project: (features) => {
    const byCategory: Record<string, string[]> = {};
    for (const feature of features) {
      (byCategory[feature.category] ??= []).push(feature.label);
    }
    return { standardEquipment: byCategory };
  },
});
