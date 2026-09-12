import type { LeadSignals } from '@/server/services/scoring/signals';
import { remember, type Exchange } from './state';
import type { Vocabulary } from './understand';

/**
 * Pass B without a model.
 *
 * The split the specification insists on is preserved exactly: this produces
 * EVIDENCE, and the existing rule engine turns evidence into a priority
 * (spec §11, §56, docs/04-spec-review.md §1). There is no scoring here, no
 * band, no weighting — only what the customer said.
 *
 * Confidence is the honest part. Everything here is either something they
 * stated outright or something the system itself observed, so it is recorded
 * high; nothing is inferred, so nothing is recorded low. The model's version of
 * this pass can read implication and will use the middle of the range. That
 * difference is why a scripted lead is thinner than a model's, not wronger.
 */

/** Stated outright — "I have $55,000", "I'm buying in two months". */
const STATED = 0.95;
/** Observed by the system rather than read out of prose — a booked slot. */
const OBSERVED = 1;

export function extractSignals(
  exchanges: Exchange[],
  options: { vocabulary?: Vocabulary; resolved?: ResolvedBuild } = {},
): LeadSignals {
  const memory = remember(exchanges, options.vocabulary);
  const signals: LeadSignals = {};

  if (memory.name) signals.customerName = { value: memory.name, confidence: OBSERVED };
  if (memory.email) signals.customerEmail = { value: memory.email, confidence: OBSERVED };
  if (memory.phone) signals.customerPhone = { value: memory.phone, confidence: OBSERVED };

  if (memory.modelSlug) signals.modelSlug = { value: memory.modelSlug, confidence: STATED };

  // Trim and powertrain are CODES, and a code only exists once the catalogue
  // has agreed that the customer's words name something it builds. Words that
  // resolved to nothing are not evidence of anything.
  if (options.resolved?.trimCode) {
    signals.trimCode = { value: options.resolved.trimCode, confidence: STATED };
  }
  if (options.resolved?.powertrainCode) {
    signals.powertrainCode = { value: options.resolved.powertrainCode, confidence: STATED };
  }
  if (options.resolved?.exteriorColourCode) {
    signals.exteriorColourCode = {
      value: options.resolved.exteriorColourCode,
      confidence: STATED,
    };
  }

  if (memory.budgetCents) {
    signals.budgetCents = { value: memory.budgetCents, confidence: STATED };
  }
  if (memory.timeframe) {
    signals.purchaseTimeframe = { value: memory.timeframe, confidence: STATED };
  }
  if (memory.financeInterest) signals.financeInterest = { value: true, confidence: STATED };
  if (memory.tradeInInterest) signals.tradeInInterest = { value: true, confidence: STATED };
  if (memory.negotiating) signals.negotiatingPrice = { value: true, confidence: STATED };
  if (memory.justBrowsing) signals.justBrowsing = { value: true, confidence: STATED };

  const intents = exchanges.map((exchange) => intentOf(exchange, options.vocabulary));

  if (intents.includes('test_drive')) {
    signals.testDriveRequested = { value: true, confidence: STATED };
    // A date only counts as one when it came with the request. A date
    // mentioned for any other reason is not a booking preference.
    if (memory.chosenSlotLabel) {
      signals.testDriveDate = { value: memory.chosenSlotLabel, confidence: OBSERVED };
    } else if (memory.latest.dateHint) {
      signals.testDriveDate = { value: memory.latest.dateHint, confidence: STATED };
    }
  }
  if (intents.includes('human') || intents.includes('callback')) {
    signals.wantsSalesperson = { value: true, confidence: STATED };
  }
  if (intents.includes('stock')) {
    signals.askedAboutAvailability = { value: true, confidence: STATED };
  }

  return signals;
}

export interface ResolvedBuild {
  trimCode?: string;
  powertrainCode?: string;
  exteriorColourCode?: string;
}

function intentOf(exchange: Exchange, vocabulary?: Vocabulary): string {
  return remember([exchange], vocabulary).latest.intent;
}
