import { z } from 'zod';
import type { FlatSignal } from './signals';

/**
 * The lead scoring rule engine.
 *
 * docs/04-spec-review.md §1: the model extracts evidence, and a deterministic,
 * tenant-configurable rule set turns evidence into a priority. That split is
 * what makes the number explainable to staff, tunable by an admin, and
 * regression-testable across model versions.
 *
 * The rationale shown to staff is assembled from the descriptions of the rules
 * that fired — a statement of evidence, never the model's reasoning (spec §11).
 */

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ field: z.string(), op: z.literal('present') }),
    z.object({ field: z.string(), op: z.literal('isTrue') }),
    z.object({ field: z.string(), op: z.literal('isFalse') }),
    z.object({ field: z.string(), op: z.literal('in'), values: z.array(z.string()) }),
    z.object({ field: z.string(), op: z.literal('gte'), value: z.number() }),
    z.object({ all: z.array(conditionSchema) }),
    z.object({ any: z.array(conditionSchema) }),
  ]),
);

export type Condition =
  | { field: string; op: 'present' }
  | { field: string; op: 'isTrue' }
  | { field: string; op: 'isFalse' }
  | { field: string; op: 'in'; values: string[] }
  | { field: string; op: 'gte'; value: number }
  | { all: Condition[] }
  | { any: Condition[] };

export interface ScoringRule {
  key: string;
  description: string;
  condition: Condition;
  weight: number;
  minConfidence: number;
  /**
   * Weaker rules this one replaces when both match.
   *
   * Without this, "requested a test drive with a date" and "asked about a test
   * drive" both fire: the score double-counts one fact, and the rationale says
   * the same thing twice. Specific rules supersede general ones.
   */
  supersedes?: string[];
}

export interface ScoreBands {
  high: number;
  medium: number;
}

export interface ScoreResult {
  score: number;
  priority: 'low' | 'medium' | 'high';
  /** Keys of the rules that fired, for the audit trail. */
  firedRules: string[];
  /** Staff-facing sentence built from those rules' descriptions. */
  rationale: string;
}

export function scoreLead(
  signals: FlatSignal[],
  rules: ScoringRule[],
  bands: ScoreBands,
): ScoreResult {
  const matched = rules.filter((rule) => evaluate(rule.condition, signals, rule.minConfidence));

  // A more specific rule replaces the general one it supersedes, so one fact
  // is counted once and described once.
  const superseded = new Set(matched.flatMap((rule) => rule.supersedes ?? []));
  const effective = matched.filter((rule) => !superseded.has(rule.key));

  const score = effective.reduce((sum, rule) => sum + rule.weight, 0);
  const fired = effective.map((rule) => rule.key);
  const positives = effective.filter((r) => r.weight > 0).map((r) => r.description);

  // Clamped rather than allowed to run away: a dealership that adds rules
  // should not be able to push every lead to HIGH by accumulating weight.
  const clamped = Math.max(0, Math.min(100, score));
  const priority = clamped >= bands.high ? 'high' : clamped >= bands.medium ? 'medium' : 'low';

  return { score: clamped, priority, firedRules: fired, rationale: buildRationale(priority, positives) };
}

function buildRationale(priority: ScoreResult['priority'], reasons: string[]): string {
  const label = priority === 'high' ? 'High' : priority === 'medium' ? 'Medium' : 'Low';
  if (reasons.length === 0) {
    return `${label} priority: no strong buying signals yet.`;
  }
  // Each reason is a sentence fragment, so every one is lowercased — not just
  // the first, which would leave capitals stranded mid-sentence.
  const fragments = reasons.map(lowerFirst);
  const list =
    fragments.length === 1
      ? fragments[0]!
      : `${fragments.slice(0, -1).join(', ')} and ${fragments.at(-1)}`;
  return `${label} priority: ${list}.`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function evaluate(condition: Condition, signals: FlatSignal[], minConfidence: number): boolean {
  if ('all' in condition) {
    return condition.all.every((c) => evaluate(c, signals, minConfidence));
  }
  if ('any' in condition) {
    return condition.any.some((c) => evaluate(c, signals, minConfidence));
  }

  const signal = signals.find((s) => s.field === condition.field);
  // An uncertain signal does not fire a rule. Spec §26: a budget we half-heard
  // should not manufacture a hot lead.
  if (!signal || signal.confidence < minConfidence) return false;

  switch (condition.op) {
    case 'present':
      return signal.value !== null && signal.value !== undefined && signal.value !== '';
    case 'isTrue':
      return signal.value === true;
    case 'isFalse':
      return signal.value === false;
    case 'in':
      return typeof signal.value === 'string' && condition.values.includes(signal.value);
    case 'gte':
      return typeof signal.value === 'number' && signal.value >= condition.value;
    default:
      return false;
  }
}

/**
 * Default weights, seeded per tenant and editable in the portal.
 *
 * These are the anchor cases from spec §11: "just browsing" must not be a hot
 * lead, and a specific configuration with a timeframe and a test drive must be.
 */
export const DEFAULT_SCORING_RULES: ScoringRule[] = [
  {
    key: 'test_drive_with_date',
    description: 'Requested a test drive with a date',
    condition: { all: [{ field: 'testDriveRequested', op: 'isTrue' }, { field: 'testDriveDate', op: 'present' }] },
    // The strongest single piece of evidence a dealership gets: a named person
    // committing to a named time. Weighted so that a dated test drive plus a
    // specific configuration reaches HIGH on its own.
    weight: 30,
    minConfidence: 0.6,
    supersedes: ['test_drive_requested'],
  },
  {
    key: 'test_drive_requested',
    description: 'Asked about a test drive',
    condition: { field: 'testDriveRequested', op: 'isTrue' },
    weight: 8,
    minConfidence: 0.6,
  },
  {
    key: 'specific_configuration',
    description: 'Selected a specific model, trim and powertrain',
    condition: {
      all: [
        { field: 'modelSlug', op: 'present' },
        { field: 'trimCode', op: 'present' },
        { field: 'powertrainCode', op: 'present' },
      ],
    },
    weight: 18,
    minConfidence: 0.7,
    supersedes: ['model_identified'],
  },
  {
    // Naming a model is itself a signal. Without this a customer comparing two
    // cars with a stated budget scored as though they had said nothing at all.
    key: 'model_identified',
    description: 'Identified a model of interest',
    condition: { field: 'modelSlug', op: 'present' },
    weight: 8,
    minConfidence: 0.7,
  },
  {
    key: 'timeframe_immediate',
    description: 'Intends to buy within a month',
    condition: { field: 'purchaseTimeframe', op: 'in', values: ['immediately', 'within_30_days'] },
    weight: 20,
    minConfidence: 0.6,
    supersedes: ['timeframe_near'],
  },
  {
    key: 'timeframe_near',
    description: 'Intends to buy within one to three months',
    condition: { field: 'purchaseTimeframe', op: 'in', values: ['one_to_three_months'] },
    weight: 12,
    minConfidence: 0.6,
  },
  {
    key: 'budget_stated',
    description: 'Stated a budget',
    condition: { field: 'budgetCents', op: 'present' },
    weight: 10,
    minConfidence: 0.6,
  },
  {
    key: 'finance_ready',
    description: 'Raised financing',
    condition: { field: 'financeInterest', op: 'isTrue' },
    weight: 10,
    minConfidence: 0.6,
  },
  {
    key: 'trade_in',
    description: 'Has a vehicle to trade in',
    condition: { field: 'tradeInInterest', op: 'isTrue' },
    weight: 8,
    minConfidence: 0.6,
  },
  {
    key: 'availability_question',
    description: 'Asked whether a specific car is in stock',
    condition: { field: 'askedAboutAvailability', op: 'isTrue' },
    weight: 8,
    minConfidence: 0.6,
  },
  {
    key: 'wants_salesperson',
    description: 'Asked to speak to a salesperson',
    condition: { field: 'wantsSalesperson', op: 'isTrue' },
    weight: 15,
    minConfidence: 0.6,
  },
  {
    key: 'negotiating',
    description: 'Discussed price or negotiation',
    condition: { field: 'negotiatingPrice', op: 'isTrue' },
    weight: 10,
    minConfidence: 0.6,
  },
  {
    key: 'contactable',
    description: 'Left contact details',
    condition: { any: [{ field: 'customerEmail', op: 'present' }, { field: 'customerPhone', op: 'present' }] },
    weight: 5,
    minConfidence: 0.7,
  },
  {
    key: 'just_browsing',
    description: 'Said they are only browsing',
    condition: { field: 'justBrowsing', op: 'isTrue' },
    weight: -20,
    minConfidence: 0.6,
  },
  {
    key: 'timeframe_distant',
    description: 'Not buying for six months or more',
    condition: { field: 'purchaseTimeframe', op: 'in', values: ['over_six_months'] },
    weight: -15,
    minConfidence: 0.6,
  },
];

export const DEFAULT_BANDS: ScoreBands = { high: 60, medium: 30 };
