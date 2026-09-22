import {
  ASKS, CANNOT_HELP, remember,
  type AskKind, type ConversationState, type Flow, type Memory, type Step,
} from './state';
import {
  voiceFor, sentences,
  ANYTHING_ELSE, GOT_IT, OFFER_TEAM, ON_IT,
} from './voice';
import { saidMatchesSlot } from './understand';
import {
  resolveTrim, resolvePowertrain, resolveColour,
  type ColourRow, type PowertrainRow, type TrimRow,
} from './resolve';
import { describe, sentenceList } from './compose';
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

/**
 * One wording of one of the assistant's questions.
 *
 * Always through here, never by reaching into ASKS: the variants and the
 * recognition that reads them back live together, and a question asked in
 * words the next turn cannot recognise is a question that gets asked twice.
 */
function ask(m: Memory, kind: AskKind): string {
  return voiceFor(m.seed).pick(`ask:${kind}`, ASKS[kind]);
}

export function decide(system: string, state: ConversationState, now: Date): Decision {
  const digest = readDigest(system);
  // The vocabulary is this tenant's own range, read from the catalogue digest
  // it was given. Add a model to the catalogue and it is understood on the
  // next request; there is no list of model names in this code (spec §1).
  const memory = remember(state.exchanges, { models: digest.models });

  return state.steps.length > 0
    ? continueTurn(memory, state.steps, digest)
    : openTurn(memory, digest, now);
}

/* -------------------------------------------------------------------------- */
/* Opening move                                                               */
/* -------------------------------------------------------------------------- */

function openTurn(m: Memory, digest: Digest, now: Date): Decision {
  // Asked about a car we do not build, say so and name what we do. The spec is
  // explicit about this (§"What you may state as fact"), and it is a far better
  // answer than "I do not have that confirmed" — which is true, but leaves the
  // customer wondering whether the Z9 exists and we are simply unsure.
  const v = voiceFor(m.seed);

  const invented = inventedModel(m, digest);
  if (invented) {
    return say(
      `${v.pick('invented', [
        `We don't make ${article(invented)} ${invented}, I'm afraid.`,
        `There's no ${invented} in our range, sorry.`,
        `We don't build ${article(invented)} ${invented}.`,
      ])} ` +
        `Here is everything ${digest.brandName} does make:\n\n${range(digest)}`,
    );
  }

  switch (m.intent) {
    case 'greeting':
      return say(
        v.pick('greeting', [
          `Hello, and welcome to ${digest.brandName}. I can talk you through the range, ` +
            "work out prices and finance, tell you what's on the ground today, or get " +
            'you booked in for a drive. What would be most useful?',
          `Hi there. I'm here to help with anything ${digest.brandName}: what we build, ` +
            "what it costs, what's in stock, or booking you a test drive. Where shall we start?",
          `Welcome to ${digest.brandName}. Ask me about any of the cars, prices, finance, ` +
            'or what we have here right now. I can also book you a drive whenever you like. ' +
            'What are you after?',
        ]),
      );

    case 'thanks':
      return say(
        sentences(
          v.pick('thanks', ['Any time.', "You're very welcome.", 'My pleasure.', 'No trouble at all.']),
          v.pick('thanks:more', ANYTHING_ELSE),
        ),
      );

    case 'hours':
      return call(t('getDealershipHours', {}));

    case 'location':
      return call(t('getDealershipInformation', {}));

    case 'search_vehicles':
      return call(t('searchVehicles', searchInput(m)));

    case 'compare':
      return m.comparisonSlugs.length >= 2
        ? call(t('compareVehicles', { modelSlugs: m.comparisonSlugs.slice(0, 3) }))
        : say(`${v.pick('compare', ['Happy to. Which two should I put side by side?', 'Sure, which two shall I compare?', "Of course. Which pair did you want to look at?"])}\n\n${range(digest)}`);

    case 'range':
      return say(
        `${v.pick('range:lead', [
          `Here's the whole ${digest.brandName} range:`,
          `This is everything we build:`,
          `The full range:`,
        ])}\n\n${range(digest)}\n\n${v.pick('range:next', [
          'Say which one catches your eye and I can go into it.',
          "Point me at one and I'll tell you more.",
          "Which of those should I open up?",
        ])}`,
      );

    // A superlative with a measure behind it. The criterion is always set when
    // the intent is 'rank' — but a missing one is a question about "the best"
    // with nothing to rank on, which is the recommendation conversation.
    case 'rank':
      return m.rankCriterion
        ? call(
            t('rankModels', {
              criterion: m.rankCriterion,
              ...(m.bodyStyle ? { bodyStyle: m.bodyStyle } : {}),
            }),
          )
        : say(recommendReply(m, digest));

    case 'best_value':
      return m.modelSlug
        ? call(t('rankTrims', { modelSlug: m.modelSlug }))
        : say(
            `${v.pick('value:which', [
              'Worth comparing properly.',
              'Good question. The steps are not all the same value.',
              'That varies by car.',
            ])} ${ask(m, 'model')}\n\n${range(digest)}`,
          );

    case 'recommend':
      return say(recommendReply(m, digest));

    case 'delivery':
      return deliveryTurn(m, digest);

    case 'specs':
      return specsTurn(m, digest);

    // A shape we do not build. Told plainly, with what we DO build underneath
    // it, which is the same courtesy the invented-model branch extends: the
    // customer learns the answer and their next question at the same time.
    case 'body_not_built':
      return say(
        `${v.pick('unbuilt', [
          `We don't build ${articleFor(m.unbuiltBody!)} ${m.unbuiltBody}, I'm afraid.`,
          `No ${m.unbuiltBody} in the range, sorry.`,
          `${digest.brandName} doesn't make ${articleFor(m.unbuiltBody!)} ${m.unbuiltBody}.`,
        ])} ${v.pick('unbuilt:next', [
          'Here is everything we do build:',
          'This is what we do make:',
          'What we do build:',
        ])}\n\n${range(digest)}`,
      );

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

    case 'service':
      return serviceTurn(m);

    default:
      // Never a bare shrug. If THIS message named a car, we know a great deal
      // about it, and leading with that is a real answer to someone plainly
      // interested in it, with the offer to chase the detail riding on top.
      //
      // Only this message, though. `m.modelSlug` remembers every car named in
      // the conversation, which is right for "and what colours does it come
      // in?" and catastrophic here: once somebody had mentioned the S5, every
      // message this branch could not parse replied with the S5 overview.
      // Four questions about other cars in a row got the same paragraph, and
      // so did "Dude". A remembered slug is not what an unrecognised sentence
      // is about.
      return m.latest.modelSlugs.length === 1
        ? call(t('getVehicle', { modelSlug: m.latest.modelSlugs[0]! }))
        : say(cannotHelp(m));
  }
}

/**
 * A measurement we do not hold.
 *
 * Boot volumes, kerb weights, tow ratings and 0–60 times are not in this
 * catalogue, and there is no version of this assistant that should produce
 * one. What it should never do is make that the customer's problem.
 *
 * So the reply is the car — what it is, what it costs, what it is built in,
 * all of it true — and then the specific figure routed to somebody who has the
 * brochure open. The customer gets information and a route to the rest of it,
 * which is what they would get from a salesperson who had to go and look.
 */
function specsTurn(m: Memory, digest: Digest): Decision {
  if (!m.modelSlug) return say(`${ask(m, 'model')}\n\n${range(digest)}`);
  return call(t('getVehicle', { modelSlug: m.modelSlug }));
}

/**
 * "What should I buy?"
 *
 * Answered with a question, which is what a good salesperson does. The range
 * is four or five cars and the customer has told us nothing; listing all of
 * them with every figure attached is not help, it is a brochure, and it is
 * exactly the wall of text this assistant used to open with.
 *
 * One question, with the possible answers named in it, so it takes a single
 * word to reply to. The answer is read back as a ranking criterion, so
 * "running costs" produces a real ordering of real figures on the next turn.
 */
function recommendReply(m: Memory, digest: Digest): string {
  const v = voiceFor(m.seed);
  return sentences(
    v.pick('rec:lead', [
      'Happy to help you narrow it down.',
      "I can help with that.",
      'Let me point you at the right one.',
    ]),
    `There are ${digest.models.length} in the range.`,
    ask(m, 'priority'),
  );
}

/**
 * How soon they can have one.
 *
 * Two different answers, and only one of them is ours to give. A car on the
 * ground has a date; a factory order does not, because build slots and
 * shipping are not in any catalogue here. So this answers the half it can from
 * stock and is explicit that the other half needs a person, rather than
 * producing a confident "six to eight weeks" out of nowhere.
 */
function deliveryTurn(m: Memory, digest: Digest): Decision {
  if (!m.modelSlug) return say(`${ask(m, 'model')}\n\n${range(digest)}`);
  return call(t('checkInventory', { modelSlug: m.modelSlug }));
}

/** Everything that needs to know which car we are talking about. */
function catalogueTurn(m: Memory, digest: Digest): Decision {
  if (m.intent === 'finance' && applying(m)) return financeRequestTurn(m, digest);

  // "What would $58,900 cost me monthly over 60 months?" needs no car. They
  // have given the figure; asking which model they meant is asking for
  // something the answer does not depend on.
  if (m.intent === 'finance' && !m.modelSlug && m.budgetCents) {
    return call(
      t('calculateFinanceEstimate', {
        vehiclePriceCents: m.budgetCents,
        termMonths: m.termMonths ?? 60,
      }),
    );
  }

  const slug = m.modelSlug;
  if (!slug) return say(`${ask(m, 'model')}\n\n${range(digest)}`);

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
      // Trims and colours are resolved against the catalogue before the stock
      // query, so "a black Premium" filters on real codes. Filtering the
      // results instead would answer "we have none" whenever the match sat
      // outside the handful of rows the tool returns.
      return call(
        t('getVehicleTrims', { modelSlug: slug }),
        t('getVehicleColours', { modelSlug: slug, kind: 'exterior' }),
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
      // Always both lookups. Which trim and engine the customer named can only
      // be known by comparing their words against what this model is actually
      // built in, and a price for an unnamed build is the cheapest trim's —
      // which is a figure the trim tool returns rather than one to assume.
      return call(
        t('getVehiclePowertrains', { modelSlug: slug }),
        t('getVehicleTrims', { modelSlug: slug }),
      );
    default:
      // The overview, plus the lists a stated configuration is resolved
      // against. "I want the S5 Premium with the 2.0 Turbo" is a build, and
      // the useful answer to it is a price rather than a brochure.
      return call(
        t('getVehicle', { modelSlug: slug }),
        t('getVehiclePowertrains', { modelSlug: slug }),
        t('getVehicleTrims', { modelSlug: slug }),
      );
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

function continueTurn(m: Memory, steps: Step[], digest: Digest): Decision {
  // A failed tool ends the turn. Carrying on would mean pricing a build from a
  // list that never arrived.
  const failed = steps.find((step) => step.isError);
  if (failed) return say(describe(failed, m.seed));

  const done = new Set(steps.map((step) => step.name));

  // A budget search that found nothing. Saying so is necessary but not
  // sufficient: the spec asks for the closest thing we do build, so the same
  // search runs again without the budget rather than leaving the customer to
  // guess what they could have (spec §5).
  if (
    m.intent === 'search_vehicles' &&
    m.budgetCents &&
    // Only worth widening when something other than the price was asked for.
    // Dropping the budget from a budget-only search returns the whole range,
    // which is not "the closest we build" — it is a change of subject.
    (m.bodyStyle || m.latest.electric || m.latest.awd) &&
    steps.length === 1 &&
    steps[0]!.name === 'searchVehicles' &&
    foundNothing(steps[0]!)
  ) {
    const wider = { ...searchInput(m) };
    delete wider.maxPriceCents;
    return call(t('searchVehicles', wider));
  }

  // Stock: the trim and colour lists came back, so the customer's words can be
  // turned into real codes and the query can filter on them.
  if (m.intent === 'stock' && done.has('getVehicleTrims') && !done.has('checkInventory')) {
    if (!m.modelSlug) return say(compose(m, steps));

    const trim = resolveTrim(m.words, rowsOf<TrimRow>(steps, 'getVehicleTrims', 'trims'));
    const colour = resolveColour(m.colourWords, rowsOf<ColourRow>(steps, 'getVehicleColours', 'colours'));

    // A colour they named that this model is not painted in. Checking stock for
    // it would report "none available", which is true and misleading.
    if (m.colourWords.length > 0 && !colour) {
      return say(
        `We do not offer ${aColour(m.colourWords[0]!)} on that one. ` +
          `${describe(steps.find((step) => step.name === 'getVehicleColours')!, m.seed)}`,
      );
    }

    return call(
      t('checkInventory', {
        modelSlug: m.modelSlug,
        ...(trim ? { trimCode: trim.code } : {}),
        ...(colour ? { exteriorColourCode: colour.code } : {}),
      }),
    );
  }

  if (
    done.has('getVehiclePowertrains') &&
    done.has('getVehicleTrims') &&
    !done.has('calculateVehiclePrice') &&
    !done.has('getVehicleOptions') &&
    !done.has('getVehicleFeatures')
  ) {
    const build = resolveBuild(m, steps);

    if (build.kind === 'not-offered') {
      const offered = build.alternatives.length
        ? `The ${build.trim.name} comes with the ${sentenceList(build.alternatives)}.`
        : 'I do not have another engine listed for that trim.';
      return say(
        `The ${build.powertrain.name} is not offered on the ${build.trim.name}. ${offered} ` +
          'Say which you would like and I will price it.',
      );
    }

    if (build.kind === 'build' && m.modelSlug) {
      const input = {
        modelSlug: m.modelSlug,
        powertrainCode: build.powertrainCode,
        trimCode: build.trimCode,
      };
      if (m.intent === 'options') return call(t('getVehicleOptions', input));
      if (m.intent === 'features') return call(t('getVehicleFeatures', input));
      // A build is only priced when the customer actually named part of it.
      // "How much is the S5?" is asking where the range starts, and the trim
      // list already carries that figure.
      if (build.named && (m.intent === 'price' || m.intent === 'vehicle_overview')) {
        return call(t('calculateVehiclePrice', input));
      }

      if (m.intent === 'price') {
        // Where the range starts, from the figure the trim tool returned —
        // not from the digest, and not by picking the smallest number seen.
        const trims = rowsOf<TrimRow & { priceFrom?: { formatted?: string } }>(
          steps, 'getVehicleTrims', 'trims',
        );
        const from = trims[0]?.priceFrom?.formatted;
        const name = digest.models.find((model) => model.slug === m.modelSlug)?.name ?? 'It';
        return say(
          [
            from ? `The ${name} starts at ${from}.` : '',
            describe(steps.find((step) => step.name === 'getVehicleTrims')!, m.seed),
            'Tell me which trim and engine you are interested in and I will price it exactly.',
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
      }
    }
  }

  // Guarded on the write having not already happened. Without that the branch
  // re-issues it every iteration: idempotency replays the first result rather
  // than double-booking, but the turn never produces a reply and the customer
  // is told nothing happened when it did.
  if (m.intent === 'finance' && done.has('getVehicle') && !done.has('createFinancingRequest')) {
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

/**
 * Which tool result actually answers each question.
 *
 * A turn usually calls two or three tools, and only one of them is the answer.
 * Asking what is in stock needs the trim and colour lists first — but nobody
 * asked for those, and printing all three results is how a reply turns into a
 * wall of text that a customer skims and gives up on.
 *
 * So the answer is chosen by what was ASKED, not by what ran last.
 */
const ANSWERS_TO: Partial<Record<Flow, string>> = {
  vehicle_overview: 'getVehicle',
  specs: 'getVehicle',
  stock: 'checkInventory',
  delivery: 'checkInventory',
  trims: 'getVehicleTrims',
  colours: 'getVehicleColours',
  powertrains: 'getVehiclePowertrains',
  options: 'getVehicleOptions',
  features: 'getVehicleFeatures',
  price: 'calculateVehiclePrice',
  rank: 'rankModels',
  best_value: 'rankTrims',
  search_vehicles: 'searchVehicles',
  compare: 'compareVehicles',
  finance: 'calculateFinanceEstimate',
  hours: 'getDealershipHours',
  location: 'getDealershipInformation',
};

/** Write tools: the record they created is the answer, whatever ran before. */
const ANSWERS = new Set([
  'getVehicle',
  'calculateVehiclePrice', 'getVehicleOptions', 'getVehicleFeatures', 'calculateFinanceEstimate',
  'rankModels', 'rankTrims', 'checkInventory', 'compareVehicles',
  'createTestDrive', 'cancelTestDrive', 'createCallbackRequest', 'createTradeInRequest',
  'createFinancingRequest', 'createSupportTicket', 'requestHumanHandoff',
]);

function compose(m: Memory, steps: Step[]): Decision['text'] {
  const last = steps.at(-1);
  if (!last) return cannotHelp(m);

  const answer = answerStep(m, steps) ?? last;
  const body = describe(answer, m.seed);

  const follow = followUp(m, answer);
  return [preamble(m, answer), body || cannotHelp(m), follow].filter(Boolean).join('\n\n');
}

/**
 * The one step worth reading out.
 *
 * In order: the tool this intent was asking for, then any tool whose result is
 * an answer in its own right, then whatever ran last. A failed step is never
 * chosen as the answer — the error branch above has already dealt with those,
 * and picking one here would report a lookup failure as the reply to a
 * question a later tool answered perfectly well.
 */
function answerStep(m: Memory, steps: Step[]): Step | undefined {
  const reversed = [...steps].reverse();

  // LAST matching call, not the first. A turn can call one tool twice — a
  // budget search that finds nothing is immediately re-run without the budget
  // — and the second call is the one that answers. Reading the first reported
  // "nothing matches" while holding a perfectly good list of alternatives.
  const wanted = ANSWERS_TO[m.intent];
  const asked = wanted && reversed.find((step) => step.name === wanted && !step.isError);
  if (asked) return asked;

  return reversed.find((step) => ANSWERS.has(step.name) && !step.isError);
}

function foundNothing(step: Step): boolean {
  const result = (step.result ?? {}) as { count?: unknown };
  return result.count === 0;
}

/** Said before the answer, where the answer alone would not address the question. */
function preamble(m: Memory, last: Step): string {
  if (last.name === 'searchVehicles' && m.budgetCents && !foundNothing(last)) {
    const searched = (last.input.maxPriceCents ?? null) === null;
    // The second, wider search. The figure comes from what they said, and the
    // prices below it come from the catalogue.
    if (searched) return 'Nothing in the range comes in under that. The closest we build:';
  }

  if (last.name === 'getVehicleColours' && !last.isError && m.colourWords.length > 0) {
    const offered = resolveColour(m.colourWords, rowsOf<ColourRow>([last], 'getVehicleColours', 'colours'));
    // A list of nine, none of them theirs. Saying so is the answer; the list is
    // the useful part that follows it. Decided by the palette, not by a
    // hardcoded idea of which colours a dealership sells.
    if (!offered) {
      return `We do not offer ${aColour(m.colourWords[0]!)} on that one. Here is what we do:`;
    }
  }
  return '';
}

function aColour(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

/**
 * An offer to put the question to somebody who can answer it.
 *
 * Deliberately built on one of the CANNOT_HELP lines, because that is how the
 * next turn recognises a "yes please" as accepting THIS offer rather than
 * agreeing to something else. The wording is a promise the code keeps: say yes
 * and a ticket is raised with the question on it.
 */
function offerToAsk(m: Memory, about: string): string {
  const v = voiceFor(m.seed);
  return sentences(
    v.pick('offer:lead', CANNOT_HELP),
    `${about}, ${v.pick('offer:team', OFFER_TEAM)}.`,
    v.pick('offer:ask', [
      'Want me to put it to them?',
      'Shall I ask them for you?',
      'Shall I get them onto it?',
      'Want me to have them come back to you with it?',
    ]),
  );
}

/** One next step, offered only where there is an obvious one. */
function followUp(m: Memory, last: Step): string {
  const v = voiceFor(m.seed);

  if (last.name === 'calculateFinanceEstimate') return ask(m, 'finance');

  if (last.name === 'checkInventory' && !last.isError) {
    // Two different questions land here. "What's in stock" is answered by the
    // list; "how soon can I have one" is only half answered by it, because a
    // factory order's timing is not in any catalogue and must not be invented.
    return m.intent === 'delivery'
      ? offerToAsk(m, 'On build and delivery times for an order')
      : v.pick('stock:drive', [
          "Say the word if you'd like to drive one and I'll check the diary.",
          'Happy to get you behind the wheel of one, just say the word.',
          'I can book you in to see one whenever suits.',
        ]);
  }

  if (last.name === 'getVehicle') {
    // The catalogue does not hold boot volumes or tow ratings, and this is
    // where that is handled honestly: real information about the car, then a
    // route to the figure — never a shrug, and never an invented number.
    if (m.intent === 'specs') return offerToAsk(m, 'On that exact figure');
    if (m.intent === 'unknown') return offerToAsk(m, 'On the specifics you asked about');
    if (m.intent === 'vehicle_overview') {
      return v.pick('overview:next', [
        'I can go into the engines, the trims, the colours or what we have in stock. Just say which.',
        'Engines, trims, colours, what we have on site. Say which and I\'ll open it up.',
        'Want the engines, the trims, the colours, or what\'s here right now?',
      ]);
    }
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
      'There is nothing bookable in the next two weeks. A specialist and a demonstrator ' +
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
    return say(`${offer(narrowed.length > 0 ? narrowed : slots)}\n\n${ask(m, 'time')}`);
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
  if (!m.name || !m.email) return say(`${lead} ${ask(m, 'contact')}`);
  if (!m.consent) return say(`${voiceFor(m.seed).pick('consent:lead', GOT_IT).replace(/\.$/, '')}, ${firstName(m.name)}. ${ask(m, 'consent')}`);
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
  if (!m.confirmationCode || !m.email) return say(`${voiceFor(m.seed).pick('cancel', ['I can sort that out.', 'Of course, no problem.', 'Easily done.'])} ${ask(m, 'code')}`);
  return call(
    t('cancelTestDrive', { confirmationCode: m.confirmationCode, email: m.email }),
  );
}

function callbackTurn(m: Memory): Decision {
  if (!m.name || !m.email) return say(`${voiceFor(m.seed).pick('callback', ON_IT)} ${ask(m, 'contact')}`);
  if (!m.phone) return say(ask(m, 'phone'));
  if (!m.consent) return say(`${voiceFor(m.seed).pick('consent:lead', GOT_IT).replace(/\.$/, '')}, ${firstName(m.name)}. ${ask(m, 'consent')}`);

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

  // Asked for only what is still missing. Re-asking for the year of a car they
  // have already named is how a form feels, and they have already typed it.
  const missingDetails = [
    vehicle.year ? '' : 'the year',
    vehicle.make && vehicle.model ? '' : 'the make and model',
    vehicle.mileageKm === undefined ? 'the rough mileage' : '',
  ].filter(Boolean);

  if (missingDetails.length > 0) {
    const known = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ');
    return say(
      known
        ? `${ask(m, 'appraisal')} What is ${sentenceList(missingDetails)} of the ${known}?`
        : `${ask(m, 'appraisal')} ${ask(m, 'vehicle')}`,
    );
  }
  if (!vehicle.condition) return say(ask(m, 'condition'));

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
  const missing = askContact(m, "Of course. I'll get a specialist onto this.");
  if (missing) return missing;

  return call(
    t('requestHumanHandoff', {
      ...contactInput(m),
      reason: reasonFrom(m, 'Customer asked to speak to a specialist.'),
      department: 'sales',
    }),
  );
}

/**
 * Service.
 *
 * There is no service booking system here and no service price list, so
 * inventing either would be the worst kind of convenient. What exists is the
 * service department's hours and a ticket the service team will answer, and
 * that is what this offers (spec §21).
 */
function serviceTurn(m: Memory): Decision {
  if (/\b(open|opening hours|what time|when are you)\b/i.test(m.said.at(-1) ?? '')) {
    return call(t('getDealershipHours', { department: 'service' }));
  }

  const missing = askContact(m, 'Our service team can help with that.');
  if (missing) return missing;

  const question = m.said.filter((said) => said.trim().length >= 12).at(0) ?? 'Service enquiry.';
  return call(
    t('createSupportTicket', {
      ...contactInput(m),
      type: 'service',
      subject: question.slice(0, 140),
      details: question.slice(0, 1500),
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
  if (!m.modelSlug) return say(`${ask(m, 'model')}\n\n${range(digest)}`);

  // The price is re-read rather than remembered: the request must record what
  // the catalogue says today, not what was quoted three turns ago.
  return call(t('getVehicle', { modelSlug: m.modelSlug }));
}

/** True when the customer accepted the offer of a specialist, or asked outright. */
function applying(m: Memory): boolean {
  return m.financeApplication;
}

function reasonFrom(m: Memory, fallback: string): string {
  const said = m.said.at(-1)?.trim();
  return said && said.length > 8 ? said.slice(0, 500) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Fallbacks                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The reply when nothing else fits.
 *
 * Three things, in this order, and the order is the whole point:
 *
 *   1. that the answer is worth getting right — not that our database is
 *      missing a row, which is our problem and not the customer's
 *   2. what CAN be answered right now, concretely, so the next message is easy
 *   3. a real offer to put the question to a person, which becomes a ticket
 *
 * What it must never be is a dead end. A customer who gets "I don't have that"
 * and nothing else closes the window, and the dealership never learns they
 * were there — which is the one outcome this whole system exists to prevent.
 */
function cannotHelp(m: Memory): string {
  const v = voiceFor(m.seed);
  return sentences(
    v.pick('cannot:lead', CANNOT_HELP),
    v.pick('cannot:can', [
      "Off the top of my head I can talk you through any of the cars, what they cost, how they're specced, what's on the ground today, a finance estimate, or get you booked in for a drive.",
      "What I've got at my fingertips: the range, prices and finance, engines and trims, colours, what's in stock right now, and the diary for test drives.",
      "I can help with any of the cars themselves: specs, trims, colours, prices, finance, what we've got here. I can book you a drive too.",
      "Ask me about any of the cars, what they cost, what they're built in, what's here today, or booking a drive, and I'll have it for you straight away.",
    ]),
    `For anything else ${v.pick('cannot:team', OFFER_TEAM)}. ${v.pick('cannot:offer', [
      'Shall I pass it on?',
      'Would you like me to pass it along?',
      'Want me to hand it over to them?',
      'Shall I get them to come back to you?',
    ])}`,
  );
}

/**
 * A model name that is not in the range.
 *
 * Two conditions, both required. The message has to be asking about a car —
 * otherwise "can I get it by Q3" is answered with a lecture about the Q3 we do
 * not build — and the token has to look like a model designation: a letter or
 * two followed by digits. "80k" and "2026" are not model names, so they start
 * with a digit and never reach here.
 */
function inventedModel(m: Memory, digest: Digest): string | undefined {
  const said = m.said.at(-1) ?? '';

  const askingAboutACar =
    /\b(model|car|vehicle|suv|sedan|tell me about|do you (make|sell|have|do|build)|how much is|in stock|interested in|looking at)\b/i.test(
      said,
    ) || said.toLowerCase().includes(digest.brandName.toLowerCase());
  if (!askingAboutACar) return undefined;

  const known = new Set(digest.models.map((model) => model.slug.toLowerCase()));
  const tokens = said.match(/\b[A-Za-z]{1,3}\d{1,3}\b/g) ?? [];

  // If they named a car we do build, the other token is something else — a
  // quarter, a trim, a number of seats — and not a model we should deny making.
  if (tokens.some((token) => known.has(token.toLowerCase()))) return undefined;

  return tokens.find(
    (token) => !known.has(token.toLowerCase()) && !readsAsATimeframe(said, token),
  );
}

/**
 * "by Q3" is a deadline; "the Q4" is a car somebody else makes.
 *
 * Decided by what sits next to it rather than by banning the shape, because
 * plenty of real models are a letter and a digit and denying we make one is
 * exactly the answer a customer asking about a rival's car needs.
 */
function readsAsATimeframe(said: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`\\b(by|in|before|after|until|during)\\s+${escaped}\\b`, 'i').test(said) ||
    new RegExp(`\\b${escaped}\\s+(of\\s+)?(next|this|last)\\s+year`, 'i').test(said) ||
    new RegExp(`\\b${escaped}\\s+20\\d\\d\\b`, 'i').test(said)
  );
}

/**
 * "an X9", not "a X9".
 *
 * By how the letter is said, not how it is spelled: F, H, L, M, N, R, S and X
 * all begin with a vowel sound when read aloud, which is how a customer reads
 * a model name.
 */
function article(token: string): string {
  return /^[AEFHILMNORSX]/i.test(token) ? 'an' : 'a';
}

/**
 * "a hatchback", not "an hatchback".
 *
 * Separate from `article` because that one is for model designations, which
 * are read out letter by letter: the H of an H5 is said "aitch" and takes
 * "an", while the H of "hatchback" is said "huh" and does not. One rule
 * cannot serve both, and sharing it produced "an hatchback".
 */
function articleFor(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/**
 * The range, by name and segment — and deliberately without prices.
 *
 * The digest is routing information, not an answer (docs/00-architecture.md
 * §4). Quoting its prices would be stating a figure no tool returned in this
 * conversation, which is the one thing the grounding rule forbids. The price
 * tools are one question away.
 */
function range(digest: Digest): string {
  return digest.models.map((model) => `- **${model.name}**: ${model.segment}`).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Resolving a build from what the tools returned                              */
/* -------------------------------------------------------------------------- */


/**
 * A model, trim and powertrain that are actually offered together.
 *
 * The catalogue is a matrix, not a set of independent lists: picking the trim
 * the customer named and the engine they named can produce a car nobody
 * builds. The pairing is checked here so the price tool is never asked for an
 * impossible combination.
 */
type Build =
  /** `named` is true when the customer identified part of the build themselves. */
  | { kind: 'build'; powertrainCode: string; trimCode: string; named: boolean }
  | { kind: 'not-offered'; trim: TrimRow; powertrain: PowertrainRow; alternatives: string[] }
  | { kind: 'unknown' };

function resolveBuild(m: Memory, steps: Step[]): Build {
  const powertrains = rowsOf<PowertrainRow>(steps, 'getVehiclePowertrains', 'powertrains');
  const trims = rowsOf<TrimRow>(steps, 'getVehicleTrims', 'trims');
  if (powertrains.length === 0 || trims.length === 0) return { kind: 'unknown' };

  const namedTrim = resolveTrim(m.words, trims);
  const namedPowertrain = resolvePowertrain(m.words, powertrains);
  let trim = namedTrim;
  let powertrain = namedPowertrain;

  // Both named, and not built together. This is told, not fixed.
  //
  // Substituting a compatible engine would produce a real price for a real
  // car — just not the one they asked about. They would learn the figure and
  // not the fact that their combination does not exist, which is the thing
  // they actually need (spec §8, INVALID_COMBINATION).
  if (trim && powertrain && !powertrain.offeredWithTrims.includes(trim.code)) {
    return {
      kind: 'not-offered',
      trim,
      powertrain,
      alternatives: powertrains
        .filter((row) => row.offeredWithTrims.includes(trim!.code))
        .map((row) => row.name),
    };
  }

  // Only one named, or neither: filling the other in is a default, not a
  // substitution, and the price tool's own summary names what it priced.
  if (trim && !powertrain) {
    powertrain = powertrains.find((row) => row.offeredWithTrims.includes(trim!.code));
  }
  powertrain ??= powertrains[0]!;
  trim ??= trims.find((row) => powertrain!.offeredWithTrims.includes(row.code)) ?? trims[0]!;

  if (!powertrain.offeredWithTrims.includes(trim.code)) {
    trim = trims.find((row) => powertrain!.offeredWithTrims.includes(row.code)) ?? trim;
  }

  return {
    kind: 'build',
    powertrainCode: powertrain.code,
    trimCode: trim.code,
    named: Boolean(namedTrim ?? namedPowertrain),
  };
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
