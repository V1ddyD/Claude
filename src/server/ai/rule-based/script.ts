import {
  ASKS, CANNOT_HELP, askedFor, remember,
  type ConversationState, type Memory, type Step,
} from './state';
import { saidMatchesSlot } from './understand';
import { describe } from './compose';
import { readDigest, localDate, type Digest } from './digest';

/**
 * What to do next.
 *
 * A defined set of instructions rather than a model: each branch names the
 * tools it calls and the facts it needs before it will call a write one. The
 * value of writing it this way is that the workflow — tool dispatch, lead
 * scoring, ticketing, email, the portal — can be exercised end to end today,
 * and every step of a booking is inspectable rather than probabilistic.
 *
 * What it does NOT do is understand. It matches patterns, and when it does not
 * recognise one it says so and offers the team, which is the same thing the
 * real assistant is instructed to do when a tool cannot answer.
 */

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface Decision {
  text: string;
  tools: ToolCall[];
}

const say = (text: string): Decision => ({ text, tools: [] });
const call = (...tools: ToolCall[]): Decision => ({ text: '', tools });
const t = (name: string, input: Record<string, unknown>): ToolCall => ({ name, input });

export function decide(system: string, state: ConversationState, now: Date): Decision {
  const digest = readDigest(system);
  const memory = remember(state.exchanges);

  return state.steps.length > 0
    ? continueTurn(memory, state.steps)
    : openTurn(memory, digest, now);
}

/* -------------------------------------------------------------------------- */
/* Opening move                                                               */
/* -------------------------------------------------------------------------- */

function openTurn(m: Memory, digest: Digest, now: Date): Decision {
  switch (m.intent) {
    case 'greeting':
      return say(
        `Welcome to ${digest.brandName}. I can talk you through the range, work out prices ` +
          'and finance estimates, check what is on the ground, and book you a test drive. ' +
          'Where would you like to start?',
      );

    case 'thanks':
      return say('Any time. Anything else you would like to know?');

    case 'hours':
      return call(t('getDealershipHours', {}));

    case 'location':
      return call(t('getDealershipInformation', {}));

    case 'search_vehicles':
      return call(t('searchVehicles', searchInput(m)));

    case 'compare':
      return m.comparisonSlugs.length >= 2
        ? call(t('compareVehicles', { modelSlugs: m.comparisonSlugs.slice(0, 3) }))
        : say(`Happy to. Which two should I put side by side?\n\n${range(digest)}`);

    case 'vehicle_overview':
    case 'price':
    case 'powertrains':
    case 'trims':
    case 'colours':
    case 'options':
    case 'features':
    case 'stock':
    case 'finance':
      return catalogueTurn(m, digest);

    case 'test_drive':
      return call(slotsCall(m, digest, now));

    case 'cancel':
      return cancelTurn(m);

    case 'callback':
      return callbackTurn(m);

    case 'trade_in':
      return tradeInTurn(m);

    case 'human':
      return handoffTurn(m);

    case 'ticket':
      return ticketTurn(m);

    default:
      return say(cannotHelp());
  }
}

/** Everything that needs to know which car we are talking about. */
function catalogueTurn(m: Memory, digest: Digest): Decision {
  if (m.intent === 'finance' && applying(m)) return financeRequestTurn(m, digest);

  const slug = m.modelSlug;
  if (!slug) return say(`${ASKS.model}\n\n${range(digest)}`);

  switch (m.intent) {
    case 'powertrains':
      return call(t('getVehiclePowertrains', { modelSlug: slug }));
    case 'trims':
      return call(t('getVehicleTrims', { modelSlug: slug }));
    case 'colours':
      return call(
        t('getVehicleColours', {
          modelSlug: slug,
          ...(/\binterior|cabin|upholster|leather|seats\b/i.test(m.said.at(-1) ?? '')
            ? { kind: 'interior' }
            : {}),
        }),
      );
    case 'stock':
      return call(
        t('checkInventory', {
          modelSlug: slug,
          ...(m.trimCode ? { trimCode: m.trimCode } : {}),
          ...(m.colourCode ? { exteriorColourCode: m.colourCode } : {}),
        }),
      );
    case 'options':
    case 'features':
      // Both are per trim and powertrain, so the codes have to be looked up
      // before they can be asked for. An option standard on one trim is a paid
      // extra on another; there is no answer without the pair.
      return call(
        t('getVehiclePowertrains', { modelSlug: slug }),
        t('getVehicleTrims', { modelSlug: slug }),
      );
    case 'price':
      return m.trimCode || m.powertrainHint
        ? call(
            t('getVehiclePowertrains', { modelSlug: slug }),
            t('getVehicleTrims', { modelSlug: slug }),
          )
        : call(t('getVehicle', { modelSlug: slug }));
    default:
      return call(t('getVehicle', { modelSlug: slug }));
  }
}

function searchInput(m: Memory): Record<string, unknown> {
  return {
    ...(m.bodyStyle ? { bodyStyle: m.bodyStyle } : {}),
    ...(m.budgetCents ? { maxPriceCents: m.budgetCents } : {}),
    ...(m.electric ? { powertrainKind: 'bev' } : {}),
    ...(m.awd ? { drivetrain: 'awd' } : {}),
  };
}

function slotsCall(m: Memory, digest: Digest, now: Date): ToolCall {
  return t('getAvailableTestDriveSlots', {
    ...(m.modelSlug ? { modelSlug: m.modelSlug } : {}),
    fromDate: localDate(now, digest.timezone),
    toDate: localDate(now, digest.timezone, 14),
  });
}

/* -------------------------------------------------------------------------- */
/* Continuing a turn, once tools have returned                                */
/* -------------------------------------------------------------------------- */

function continueTurn(m: Memory, steps: Step[]): Decision {
  // A failed tool ends the turn. Carrying on would mean pricing a build from a
  // list that never arrived.
  const failed = steps.find((step) => step.isError);
  if (failed) return say(describe(failed));

  const done = new Set(steps.map((step) => step.name));

  if (
    done.has('getVehiclePowertrains') &&
    done.has('getVehicleTrims') &&
    !done.has('calculateVehiclePrice') &&
    !done.has('getVehicleOptions') &&
    !done.has('getVehicleFeatures')
  ) {
    const build = resolveBuild(m, steps);
    if (build && m.modelSlug) {
      const input = { modelSlug: m.modelSlug, ...build };
      if (m.intent === 'options') return call(t('getVehicleOptions', input));
      if (m.intent === 'features') return call(t('getVehicleFeatures', input));
      if (m.intent === 'price') return call(t('calculateVehiclePrice', input));
    }
  }

  if (m.intent === 'finance' && done.has('getVehicle')) {
    const cents = startingPriceCents(steps);
    if (cents && applying(m) && m.name && m.email && m.consent) {
      return call(
        t('createFinancingRequest', {
          ...contactInput(m),
          vehiclePriceCents: cents,
          termMonths: m.termMonths ?? 60,
        }),
      );
    }
    if (cents && !done.has('calculateFinanceEstimate')) {
      return call(
        t('calculateFinanceEstimate', { vehiclePriceCents: cents, termMonths: m.termMonths ?? 60 }),
      );
    }
  }

  if (done.has('getAvailableTestDriveSlots') && !done.has('createTestDrive')) {
    return bookingTurn(m, steps);
  }

  return say(compose(m, steps));
}

/** Tools whose result IS the answer; anything before them was groundwork. */
const ANSWERS = new Set([
  'calculateVehiclePrice', 'getVehicleOptions', 'getVehicleFeatures', 'calculateFinanceEstimate',
  'createTestDrive', 'cancelTestDrive', 'createCallbackRequest', 'createTradeInRequest',
  'createFinancingRequest', 'createSupportTicket', 'requestHumanHandoff',
]);

function compose(m: Memory, steps: Step[]): Decision['text'] {
  const last = steps.at(-1);
  if (!last) return cannotHelp();

  const body = ANSWERS.has(last.name)
    ? describe(last)
    : steps.map(describe).filter(Boolean).join('\n\n');

  const follow = followUp(m, last);
  return [body || cannotHelp(), follow].filter(Boolean).join('\n\n');
}

/** One next step, offered only where there is an obvious one. */
function followUp(m: Memory, last: Step): string {
  if (last.name === 'calculateFinanceEstimate') return ASKS.finance;
  if (last.name === 'checkInventory' && !last.isError) {
    return 'Say the word if you would like to drive one and I will check the diary.';
  }
  if (last.name === 'getVehicle' && m.intent === 'vehicle_overview') {
    return 'I can go into the engines, the trims, the colours or what is in stock — whichever is useful.';
  }
  return '';
}

/* -------------------------------------------------------------------------- */
/* Booking                                                                     */
/* -------------------------------------------------------------------------- */

interface Slot {
  startsAt: string;
  label: string;
}

function bookingTurn(m: Memory, steps: Step[]): Decision {
  const slots = slotsFrom(steps);

  if (slots.length === 0) {
    // Not a dead end: a booking needs a specialist AND a demonstrator free, and
    // when neither is, the enquiry still has to reach a person.
    const missing = askContact(
      m,
      'There is nothing bookable in the next two weeks — a specialist and a demonstrator ' +
        'both have to be free. I can ask the team to find you a time.',
    );
    if (missing) return missing;

    return call(
      t('requestHumanHandoff', {
        ...contactInput(m),
        reason: 'Wants a test drive; nothing available in the next 14 days.',
        department: 'sales',
      }),
    );
  }

  const narrowed = narrowSlots(slots, m);
  const chosen = narrowed.length === 1 ? narrowed[0]! : undefined;

  if (!chosen) {
    return say(`${offer(narrowed.length > 0 ? narrowed : slots)}\n\n${ASKS.time}`);
  }

  const missing = askContact(m, `${chosen.label} works.`);
  if (missing) return missing;

  return call(
    t('createTestDrive', {
      startsAt: chosen.startsAt,
      ...(m.modelSlug ? { modelSlug: m.modelSlug } : {}),
      ...contactInput(m),
    }),
  );
}

function slotsFrom(steps: Step[]): Slot[] {
  const step = steps.find((s) => s.name === 'getAvailableTestDriveSlots');
  const result = (step?.result ?? {}) as { slots?: unknown };
  return Array.isArray(result.slots)
    ? (result.slots as Slot[]).filter((s) => typeof s?.startsAt === 'string')
    : [];
}

function offer(slots: Slot[]): string {
  return slots
    .slice(0, 5)
    .map((slot, index) => `${index + 1}. ${slot.label}`)
    .join('\n');
}

/**
 * Which of the offered times the customer meant.
 *
 * Returns every slot still in play rather than a single guess: "Saturday" with
 * three Saturday slots is a narrowing, not a choice, and booking one of them
 * would be inventing a decision the customer never made.
 */
function narrowSlots(slots: Slot[], m: Memory): Slot[] {
  if (m.chosenSlotLabel) {
    // If the time they picked has since been taken, this is empty and the
    // customer is asked again rather than booked into a different slot.
    return slots.filter((slot) => slot.label === m.chosenSlotLabel);
  }

  for (const said of [...m.said].reverse()) {
    const matched = slots.filter((slot) => saidMatchesSlot(slot.label, said));
    if (matched.length > 0) return matched;
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Requests that need contact details                                          */
/* -------------------------------------------------------------------------- */

/**
 * The gate in front of every write tool.
 *
 * Consent is a yes to a question about being contacted. An email address is an
 * identifier, not a permission, so giving one is never treated as agreeing to
 * anything (spec §19, docs/08-security-review.md).
 */
function askContact(m: Memory, lead: string): Decision | undefined {
  if (!m.name || !m.email) return say(`${lead} ${ASKS.contact}`);
  if (!m.consent) return say(`Thanks, ${firstName(m.name)}. ${ASKS.consent}`);
  return undefined;
}

function contactInput(m: Memory): Record<string, unknown> {
  return {
    fullName: m.name!,
    email: m.email!,
    ...(m.phone ? { phone: m.phone } : {}),
    contactConsent: true as const,
  };
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

function cancelTurn(m: Memory): Decision {
  if (!m.confirmationCode || !m.email) return say(`I can sort that out. ${ASKS.code}`);
  return call(
    t('cancelTestDrive', { confirmationCode: m.confirmationCode, email: m.email }),
  );
}

function callbackTurn(m: Memory): Decision {
  if (!m.name || !m.email) return say(`Of course. ${ASKS.contact}`);
  if (!m.phone) return say(ASKS.phone);
  if (!m.consent) return say(`Thanks, ${firstName(m.name)}. ${ASKS.consent}`);

  return call(
    t('createCallbackRequest', {
      ...contactInput(m),
      phone: m.phone,
      reason: reasonFrom(m, 'Asked for a call back.'),
    }),
  );
}

function tradeInTurn(m: Memory): Decision {
  const vehicle = m.tradeIn;
  if (!vehicle.year || !vehicle.make || !vehicle.model || vehicle.mileageKm === undefined) {
    return say(`Happy to get that appraised. ${ASKS.vehicle}`);
  }
  if (!vehicle.condition) return say(ASKS.condition);

  const missing = askContact(m, 'Thank you.');
  if (missing) return missing;

  return call(
    t('createTradeInRequest', {
      ...contactInput(m),
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      mileageKm: vehicle.mileageKm,
      condition: vehicle.condition,
    }),
  );
}

function handoffTurn(m: Memory): Decision {
  const missing = askContact(m, 'Of course — I will get a specialist onto this.');
  if (missing) return missing;

  return call(
    t('requestHumanHandoff', {
      ...contactInput(m),
      reason: reasonFrom(m, 'Customer asked to speak to a specialist.'),
      department: 'sales',
    }),
  );
}

function ticketTurn(m: Memory): Decision {
  const missing = askContact(m, 'I will pass it to the team.');
  if (missing) return missing;

  const question = m.openQuestion ?? 'A question the assistant could not answer.';
  return call(
    t('createSupportTicket', {
      ...contactInput(m),
      type: 'sales_enquiry',
      subject: question.slice(0, 140),
      details: question.slice(0, 1500),
    }),
  );
}

function financeRequestTurn(m: Memory, digest: Digest): Decision {
  const missing = askContact(m, 'I can get a specialist to confirm the terms.');
  if (missing) return missing;
  if (!m.modelSlug) return say(`${ASKS.model}\n\n${range(digest)}`);

  // The price is re-read rather than remembered: the request must record what
  // the catalogue says today, not what was quoted three turns ago.
  return call(t('getVehicle', { modelSlug: m.modelSlug }));
}

/** True when the customer accepted the offer of a specialist, or asked outright. */
function applying(m: Memory): boolean {
  if (askedFor(m.asked, 'finance') && m.latest.affirmative) return true;
  return /\b(apply|application|pre.?approv|proceed with financ|sort out financ)/i.test(
    m.said.at(-1) ?? '',
  );
}

function reasonFrom(m: Memory, fallback: string): string {
  const said = m.said.at(-1)?.trim();
  return said && said.length > 8 ? said.slice(0, 500) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Fallbacks                                                                   */
/* -------------------------------------------------------------------------- */

function cannotHelp(): string {
  return (
    `${CANNOT_HELP} I can talk you through the range, prices, what is on the ground, ` +
    'a finance estimate, or book you a test drive. If it is something else, the team ' +
    'can answer it — would you like me to pass it on?'
  );
}

function range(digest: Digest): string {
  return digest.models
    .map((model) => `- **${model.name}** — ${model.segment}, from ${model.priceFrom}`)
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* Resolving a build from what the tools returned                              */
/* -------------------------------------------------------------------------- */

interface PowertrainRow {
  code: string;
  name: string;
  type: string;
  offeredWithTrims: string[];
}
interface TrimRow {
  code: string;
  name: string;
}

/**
 * A model, trim and powertrain that are actually offered together.
 *
 * The catalogue is a matrix, not a set of independent lists: picking the trim
 * the customer named and the engine they named can produce a car nobody
 * builds. The pairing is checked here so the price tool is never asked for an
 * impossible combination.
 */
function resolveBuild(
  m: Memory,
  steps: Step[],
): { powertrainCode: string; trimCode: string } | undefined {
  const powertrains = rowsOf<PowertrainRow>(steps, 'getVehiclePowertrains', 'powertrains');
  const trims = rowsOf<TrimRow>(steps, 'getVehicleTrims', 'trims');
  if (powertrains.length === 0 || trims.length === 0) return undefined;

  let trim = m.trimCode ? trims.find((row) => row.code === m.trimCode) : undefined;
  let powertrain = m.powertrainHint ? matchPowertrain(powertrains, m.powertrainHint) : undefined;

  if (trim && (!powertrain || !powertrain.offeredWithTrims.includes(trim.code))) {
    // The trim the customer named wins; the engine moves to one offered with it.
    powertrain = powertrains.find((row) => row.offeredWithTrims.includes(trim!.code)) ?? powertrain;
  }
  powertrain ??= powertrains[0]!;
  trim ??= trims.find((row) => powertrain!.offeredWithTrims.includes(row.code)) ?? trims[0]!;

  if (!powertrain.offeredWithTrims.includes(trim.code)) {
    const fallback = powertrains.find((row) => row.offeredWithTrims.includes(trim!.code));
    if (fallback) powertrain = fallback;
    else trim = trims.find((row) => powertrain!.offeredWithTrims.includes(row.code)) ?? trim;
  }

  return { powertrainCode: powertrain.code, trimCode: trim.code };
}

function matchPowertrain(rows: PowertrainRow[], hint: string): PowertrainRow | undefined {
  if (hint === 'hybrid') return rows.find((row) => row.type === 'hybrid' || row.type === 'phev');
  return rows.find(
    (row) => row.code.toLowerCase().startsWith(hint) || row.name.toLowerCase().includes(hint),
  );
}

function rowsOf<T>(steps: Step[], toolName: string, key: string): T[] {
  const step = steps.find((s) => s.name === toolName && !s.isError);
  const result = (step?.result ?? {}) as Record<string, unknown>;
  return Array.isArray(result[key]) ? (result[key] as T[]) : [];
}

function startingPriceCents(steps: Step[]): number | undefined {
  const step = steps.find((s) => s.name === 'getVehicle' && !s.isError);
  const result = (step?.result ?? {}) as { priceFrom?: { cents?: unknown } };
  const cents = result.priceFrom?.cents;
  return typeof cents === 'number' && cents > 0 ? cents : undefined;
}
