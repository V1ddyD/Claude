import { z } from 'zod';

/**
 * The structured evidence the extraction pass produces.
 *
 * This is the contract between the model and the rest of the system. It is a
 * strict schema: the model fills it in, and anything that does not validate is
 * discarded rather than coerced, because a hallucinated budget that becomes a
 * HIGH-priority lead sends a salesperson after a customer who never said it.
 */

export const PURCHASE_TIMEFRAMES = [
  'immediately', 'within_30_days', 'one_to_three_months',
  'three_to_six_months', 'over_six_months', 'unknown',
] as const;

/** Every extracted field carries its own confidence and the message it came from. */
const signal = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value,
    confidence: z.number().min(0).max(1),
  });

export const leadSignalsSchema = z.object({
  modelSlug: signal(z.string()).nullable().optional(),
  trimCode: signal(z.string()).nullable().optional(),
  powertrainCode: signal(z.string()).nullable().optional(),
  exteriorColourCode: signal(z.string()).nullable().optional(),
  budgetCents: signal(z.number().int().positive()).nullable().optional(),
  purchaseTimeframe: signal(z.enum(PURCHASE_TIMEFRAMES)).nullable().optional(),
  financeInterest: signal(z.boolean()).nullable().optional(),
  tradeInInterest: signal(z.boolean()).nullable().optional(),
  testDriveRequested: signal(z.boolean()).nullable().optional(),
  testDriveDate: signal(z.string()).nullable().optional(),
  wantsSalesperson: signal(z.boolean()).nullable().optional(),
  negotiatingPrice: signal(z.boolean()).nullable().optional(),
  askedAboutAvailability: signal(z.boolean()).nullable().optional(),
  justBrowsing: signal(z.boolean()).nullable().optional(),
  customerName: signal(z.string()).nullable().optional(),
  customerEmail: signal(z.string().email()).nullable().optional(),
  customerPhone: signal(z.string()).nullable().optional(),
});

export type LeadSignals = z.infer<typeof leadSignalsSchema>;
export type SignalField = keyof LeadSignals;

/** Flattened for the rule engine and for persistence. */
export interface FlatSignal {
  field: string;
  value: unknown;
  confidence: number;
}

export function flattenSignals(signals: LeadSignals): FlatSignal[] {
  const out: FlatSignal[] = [];
  for (const [field, entry] of Object.entries(signals)) {
    if (!entry || entry.value === null || entry.value === undefined) continue;
    out.push({ field, value: entry.value, confidence: entry.confidence });
  }
  return out;
}
