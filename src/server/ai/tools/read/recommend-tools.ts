import { z } from 'zod';
import { and, eq, gte, inArray, asc, isNotNull } from 'drizzle-orm';
import { defineTool, type ToolContext } from '../define';
import {
  vehicleModels, modelConfigurations, powertrains, vehicleFeatures, leads,
  inventoryUnits,
} from '@/server/db/schema';
import * as catalogue from '@/server/db/repositories/catalogue';
import { notFound } from '@/server/errors';
import { money } from '../projections/catalogue';

/**
 * "Which one should I get?"
 *
 * The questions a customer actually opens with — cheapest, fastest, most
 * popular, which trim is worth the money — and the ones a catalogue lookup
 * cannot answer, because none of them name a car.
 *
 * Every one of them is answered by MEASURING something the dealership already
 * records, and by saying which measure was used. That is the whole design:
 *
 *   - a ranking is only ever an ordering of real figures, never a verdict
 *   - the measure travels with the answer, so the customer can disagree with
 *     it ("cheapest to run, by fuel consumption") rather than being handed a
 *     recommendation with no basis
 *   - where the figure does not exist, the model is left out of the ranking
 *     rather than given a zero and buried at the bottom
 *
 * Popularity is the awkward one, and it is worth being explicit about why.
 * There is no popularity column in a catalogue, and inventing one — "the S5 is
 * our most popular" — is the single most tempting lie an assistant like this
 * can tell, because nobody can check it and it always sounds plausible.
 *
 * So it is measured, twice: what customers here have been asking about, and
 * failing that how many of each the dealership keeps on the ground. Both are
 * true things about this dealership, and whichever one answered is named in
 * the reply, so the customer knows what they are being told.
 *
 * What is never returned either way: the counts. The ORDER is a fact about the
 * range. How many enquiries came in, or how many cars are on the lot, is the
 * dealership's own business, and a customer who can read it off a chatbot can
 * read a competitor's off theirs.
 */

/** How far back an enquiry still counts towards what people are asking about. */
const POPULARITY_WINDOW_DAYS = 180;

/**
 * Enquiries the leader needs before an ordering is worth stating.
 *
 * Two customers asking about different cars is not a ranking, it is a
 * coincidence, and "our most popular" said on the strength of it is false.
 */
const POPULARITY_MINIMUM = 3;

const CRITERIA = [
  'price_low',
  'price_high',
  'power',
  'electric_range',
  'efficiency',
  'popularity',
] as const;

type Criterion = (typeof CRITERIA)[number];

/** Said to the customer, so they know what the ordering actually measured. */
const MEASURES: Record<Criterion, string> = {
  price_low: 'what each one starts at',
  price_high: 'what each one starts at, most expensive first',
  power: 'the most powerful engine offered in each',
  electric_range: 'the best electric range offered in each',
  efficiency: 'fuel consumption, so electric models are not in this one',
  popularity: 'what customers here have been asking about',
};

/** The second reading of "popular", used when enquiries are too thin. */
const STOCK_DEPTH_MEASURE = 'what we keep most of on the ground';

interface Ranked {
  slug: string;
  name: string;
  segment: string;
  priceFromCents: number;
  /** The figure the ordering was made on, already worded. Null for popularity. */
  value: string | null;
  sortKey: number;
}

export const rankModels = defineTool({
  name: 'rankModels',
  scope: 'read',
  summary:
    'Order the range by one measurable thing: cheapest or dearest, most powerful, ' +
    'longest electric range, lowest fuel consumption, or most popular. Use when a ' +
    'customer asks which car is best, cheapest, fastest or most popular instead of ' +
    'naming one. Popularity is measured from this dealership\'s own enquiries, or from ' +
    'how many of each it stocks — the result names which, and that wording must be ' +
    'passed on rather than reported as a bare opinion.',
  input: z.object({
    criterion: z.enum(CRITERIA),
    bodyStyle: z
      .enum(['sedan', 'coupe', 'suv', 'crossover', 'pickup', 'wagon'])
      .optional(),
  }),
  handler: async (ctx, input) => {
    const conditions = [
      eq(vehicleModels.tenantId, ctx.tenantId),
      eq(vehicleModels.status, 'published'),
    ];
    if (input.bodyStyle) conditions.push(eq(vehicleModels.bodyStyle, input.bodyStyle));

    const models = await ctx.db
      .select({
        id: vehicleModels.id,
        slug: vehicleModels.slug,
        fullName: vehicleModels.fullName,
        segment: vehicleModels.segment,
        baseMsrpCents: vehicleModels.baseMsrpCents,
      })
      .from(vehicleModels)
      .where(and(...conditions))
      .orderBy(asc(vehicleModels.displayOrder))
      .limit(20);

    if (models.length === 0) {
      return { criterion: input.criterion, ranked: [], enough: false, measure: undefined };
    }

    if (input.criterion === 'popularity') {
      return rankByEnquiries(ctx, models);
    }

    const specs = await ctx.db
      .select({
        modelId: modelConfigurations.modelId,
        priceCents: modelConfigurations.priceCents,
        horsepower: powertrains.horsepower,
        rangeKm: powertrains.rangeKm,
        kind: powertrains.kind,
        consumptionL100: powertrains.consumptionL100,
      })
      .from(modelConfigurations)
      .innerJoin(powertrains, eq(powertrains.id, modelConfigurations.powertrainId))
      .where(
        and(
          eq(modelConfigurations.tenantId, ctx.tenantId),
          inArray(modelConfigurations.modelId, models.map((m) => m.id)),
        ),
      );

    const ranked: Ranked[] = [];

    for (const model of models) {
      const rows = specs.filter((spec) => spec.modelId === model.id);
      // A model with no priced configuration has no starting price to quote
      // and nothing to rank; the catalogue figure is used rather than a guess.
      const priceFromCents = rows.length
        ? Math.min(...rows.map((r) => r.priceCents))
        : model.baseMsrpCents;

      const entry = measure(input.criterion, rows, priceFromCents, ctx.tenant);
      // Left out entirely, not scored zero. A model with no range figure is
      // not the shortest-range car we build; it is one we cannot rank here.
      if (!entry) continue;

      ranked.push({
        slug: model.slug,
        name: model.fullName,
        segment: model.segment,
        priceFromCents,
        value: entry.value,
        sortKey: entry.sortKey,
      });
    }

    ranked.sort((a, b) => a.sortKey - b.sortKey);
    return {
      criterion: input.criterion,
      ranked,
      enough: ranked.length > 0,
      measure: undefined,
    };
  },
  project: ({ criterion, ranked, enough, measure }, ctx) => ({
    criterion,
    measure: measure ?? MEASURES[criterion as Criterion],
    /** False means "not enough to say", never "nothing is popular". */
    enough,
    count: ranked.length,
    models: ranked.slice(0, 6).map((row) => ({
      slug: row.slug,
      name: row.name,
      segment: row.segment,
      priceFrom: money(row.priceFromCents, ctx.tenant),
      // The figure the ordering was made on, so the ranking is checkable.
      // Null on popularity: the order is a fact about the range, the count is
      // the dealership's own business.
      value: row.value,
    })),
  }),
});

/**
 * The figure this model is ranked on, worded, plus the key to sort by.
 *
 * Ascending throughout — the sign is applied here rather than at the sort, so
 * a criterion that means "most" cannot be added later and quietly rank
 * backwards.
 */
function measure(
  criterion: Criterion,
  rows: {
    priceCents: number;
    horsepower: number | null;
    rangeKm: number | null;
    kind: string;
    consumptionL100: string | null;
  }[],
  priceFromCents: number,
  tenant: { currency: string; locale: string },
): { value: string | null; sortKey: number } | undefined {
  switch (criterion) {
    case 'price_low':
      return {
        value: `from ${money(priceFromCents, tenant).formatted}`,
        sortKey: priceFromCents,
      };

    case 'price_high':
      return {
        value: `from ${money(priceFromCents, tenant).formatted}`,
        sortKey: -priceFromCents,
      };

    case 'power': {
      const best = Math.max(0, ...rows.map((r) => r.horsepower ?? 0));
      return best > 0 ? { value: `up to ${best} hp`, sortKey: -best } : undefined;
    }

    case 'electric_range': {
      // Only where the car can actually drive on the battery. A petrol car's
      // absent range figure is not a short range.
      const electric = rows.filter((r) => r.kind === 'bev' || r.kind === 'phev');
      const best = Math.max(0, ...electric.map((r) => r.rangeKm ?? 0));
      return best > 0 ? { value: `up to ${best} km electric`, sortKey: -best } : undefined;
    }

    case 'efficiency': {
      const figures = rows
        .map((r) => Number(r.consumptionL100))
        .filter((value) => Number.isFinite(value) && value > 0);
      if (figures.length === 0) return undefined;
      const best = Math.min(...figures);
      return { value: `${best} L/100km at best`, sortKey: best };
    }

    default:
      return undefined;
  }
}

/**
 * What people here have been asking about.
 *
 * Counted from this tenant's own leads, which is the only true source for it,
 * and returned as an ORDER with no numbers attached. Below the threshold the
 * ranking is thrown away rather than published with a caveat: a caveat under a
 * ranking still leaves the ranking on the screen, and the customer remembers
 * the order, not the footnote.
 */
type PopularityResult = {
  criterion: Criterion;
  ranked: Ranked[];
  enough: boolean;
  measure: string | undefined;
};

interface CandidateModel {
  id: string;
  slug: string;
  fullName: string;
  segment: string;
  baseMsrpCents: number;
}

/**
 * What "popular" honestly means here.
 *
 * Two real measures, tried in order, and whichever one answers says so.
 *
 *   enquiries    what customers have actually been asking about. The truest
 *                answer, and the one a dealership means by the word — but it
 *                needs a body of conversations behind it, which a dealership
 *                in its first month does not have.
 *
 *   stock depth  how many of each are on the ground. A dealership orders
 *                inventory in proportion to what it expects to sell, so the
 *                shape of the forecourt is a real signal about demand, and it
 *                is available from day one.
 *
 * Neither is invented and neither is presented as the other: the measure is
 * returned with the ranking and read out with it. Falling back is not a fudge
 * — it is answering a slightly different question and saying which one.
 *
 * If both are empty the tool still reports nothing rather than guessing. A
 * dealership with no enquiries and no cars has no answer to give.
 *
 * What is never returned either way: the counts. The ORDER is a fact about the
 * range; how many enquiries came in, or how many cars are on the lot, is the
 * dealership's own business.
 */
async function rankByEnquiries(
  ctx: ToolContext,
  models: CandidateModel[],
): Promise<PopularityResult> {
  const since = new Date(ctx.now.getTime() - POPULARITY_WINDOW_DAYS * 86_400_000);

  const enquiries = await ctx.db
    .select({ modelId: leads.modelId })
    .from(leads)
    .where(
      and(
        eq(leads.tenantId, ctx.tenantId),
        isNotNull(leads.modelId),
        gte(leads.createdAt, since),
      ),
    )
    .limit(5000);

  const counts = new Map<string, number>();
  for (const row of enquiries) {
    if (row.modelId) counts.set(row.modelId, (counts.get(row.modelId) ?? 0) + 1);
  }

  const asked = orderBy(models, counts);
  // Two enquiries about different cars is a coincidence, not a ranking, and
  // "our most popular" said on the strength of it is simply false.
  if (asked.length > 0 && (counts.get(leaderId(models, asked)) ?? 0) >= POPULARITY_MINIMUM) {
    return {
      criterion: 'popularity',
      ranked: asked,
      enough: true,
      measure: MEASURES.popularity,
    };
  }

  const units = await ctx.db
    .select({ modelId: modelConfigurations.modelId })
    .from(inventoryUnits)
    .innerJoin(
      modelConfigurations,
      eq(modelConfigurations.id, inventoryUnits.modelConfigurationId),
    )
    .where(
      and(
        eq(inventoryUnits.tenantId, ctx.tenantId),
        eq(inventoryUnits.status, 'available'),
      ),
    )
    .limit(5000);

  const stock = new Map<string, number>();
  for (const row of units) stock.set(row.modelId, (stock.get(row.modelId) ?? 0) + 1);

  const held = orderBy(models, stock);
  if (held.length > 0) {
    return {
      criterion: 'popularity',
      ranked: held,
      enough: true,
      measure: STOCK_DEPTH_MEASURE,
    };
  }

  return { criterion: 'popularity', ranked: [], enough: false, measure: undefined };
}

/** The models with a count against them, most first. Ties keep catalogue order. */
function orderBy(models: CandidateModel[], counts: Map<string, number>): Ranked[] {
  return models
    .filter((model) => (counts.get(model.id) ?? 0) > 0)
    .map((model) => ({
      slug: model.slug,
      name: model.fullName,
      segment: model.segment,
      priceFromCents: model.baseMsrpCents,
      value: null,
      sortKey: -(counts.get(model.id) ?? 0),
    }))
    .sort((a, b) => a.sortKey - b.sortKey);
}

/** The id behind the top row, so its count can be checked against the floor. */
function leaderId(models: CandidateModel[], ranked: Ranked[]): string {
  return models.find((model) => model.slug === ranked[0]!.slug)!.id;
}
/**
 * Which trim is worth the money.
 *
 * A genuinely common question with no factual answer, so what comes back is
 * not a verdict but the ladder itself: what each step costs and what it adds
 * as standard. "Value" is then a measure the customer can see and argue with —
 * equipment gained per pound of step-up — rather than a preference the
 * assistant made up.
 *
 * The equipment counted is standard equipment only. Options are not counted,
 * because a trim that merely makes more things BUYABLE has not added anything
 * to the car you drive away.
 */
export const rankTrims = defineTool({
  name: 'rankTrims',
  scope: 'read',
  summary:
    'The trim ladder for one model: what each level starts at, what the step up from ' +
    'the one below costs, and what standard equipment that step buys. Use for "which ' +
    'trim is best value", "is the top trim worth it" or "what do I get for the extra". ' +
    'The value measure is equipment gained per unit of price — state it, do not present ' +
    'the result as an opinion.',
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
    if (configurations.length === 0) throw notFound('That combination');

    // One configuration per trim — the cheapest, because that is the figure a
    // trim "starts at" and the one the rest of the assistant already quotes.
    const cheapest = new Map<string, (typeof configurations)[number]>();
    for (const c of configurations) {
      const existing = cheapest.get(c.trimCode);
      if (!existing || c.priceCents < existing.priceCents) cheapest.set(c.trimCode, c);
    }

    const rungs = [...cheapest.values()].sort(
      (a, b) => a.tierOrder - b.tierOrder || a.priceCents - b.priceCents,
    );

    // One query, not one per trim: the ladder is short, but a loop of queries
    // inside a conversation transaction is a habit worth not forming.
    const features = await ctx.db
      .select({
        configurationId: vehicleFeatures.modelConfigurationId,
        label: vehicleFeatures.label,
      })
      .from(vehicleFeatures)
      .where(
        and(
          eq(vehicleFeatures.tenantId, ctx.tenantId),
          inArray(vehicleFeatures.modelConfigurationId, rungs.map((r) => r.id)),
        ),
      )
      .limit(500);

    const byConfiguration = new Map<string, Set<string>>();
    for (const rung of rungs) byConfiguration.set(rung.id, new Set());
    for (const row of features) byConfiguration.get(row.configurationId)?.add(row.label);

    return { model, rungs, byConfiguration };
  },
  project: ({ model, rungs, byConfiguration }, ctx) => {
    const steps = rungs.map((rung, index) => {
      const below = index > 0 ? rungs[index - 1]! : undefined;
      const here = byConfiguration.get(rung.id) ?? new Set<string>();
      const under = below ? byConfiguration.get(below.id) ?? new Set<string>() : new Set<string>();
      const gained = [...here].filter((label) => !under.has(label));
      const stepCents = below ? rung.priceCents - below.priceCents : 0;

      return {
        code: rung.trimCode,
        name: rung.trimName,
        priceCents: rung.priceCents,
        stepCents,
        gained,
        standardFeatureCount: here.size,
        // Equipment per unit of price. Only meaningful where money actually
        // changed hands, so a same-price trim scores nothing rather than
        // dividing by zero and winning.
        rate: stepCents > 0 ? gained.length / stepCents : 0,
      };
    });

    const best = steps.reduce<(typeof steps)[number] | undefined>(
      (winner, step) => (step.rate > (winner?.rate ?? 0) ? step : winner),
      undefined,
    );

    return {
      model: model.fullName,
      measure: 'standard equipment gained for what the step up costs',
      trims: steps.map((step) => ({
        code: step.code,
        name: step.name,
        priceFrom: money(step.priceCents, ctx.tenant),
        stepUp: step.stepCents > 0 ? money(step.stepCents, ctx.tenant) : null,
        standardFeatureCount: step.standardFeatureCount,
        // Capped: the point is what the step buys, not a full inventory of it.
        adds: step.gained.slice(0, 5),
        moreAdds: Math.max(0, step.gained.length - 5),
      })),
      // Null where no step adds anything measurable — which is an answer, and
      // a more honest one than picking the dearest.
      bestStepUp: best ? best.code : null,
    };
  },
});
