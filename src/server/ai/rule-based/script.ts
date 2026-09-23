import {
  ASKS, RETRIES, UNSURE, GET_IT_RIGHT, TEAM_OFFER_TAILS, remember,
  type AskKind, type ConversationState, type Flow, type Memory, type Step,
} from './state';
import {
  voiceFor, sentences, paragraphs,
  ANYTHING_ELSE, GOT_IT, OFFER_TEAM, OFFER_DRIVE, OFFER_HUMAN, OPENERS, ON_IT,
  type Voice,
} from './voice';
import { saidMatchesSlot } from './understand';
import {
  resolveTrim, resolvePowertrain, resolveColour,
  type ColourRow, type PowertrainRow, type TrimRow,
} from './resolve';
import {
  describe, sentenceList, capitalise, count,
  describeFeatureCheck, describeCharging, describeTransmission,
  type DescribeContext,
} from './compose';
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
 * recognise one it says so, offers what it can do, and after the third miss in
 * a row stops guessing and offers a person.
 *
 * How it sounds is decided in three places, and only three:
 *
 *   voice.ts     the banks of interchangeable phrasings, and the rule that a
 *                phrasing used in the previous reply is not used again
 *   compose.ts   how a tool result is laid out
 *   finish()     below: the last pass every reply goes through
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

/** A voice for this reply, which will not reuse a phrasing from the last one. */
function voice(m: Memory): Voice {
  return voiceFor(m.seed, m.asked);
}

/**
 * One wording of one of the assistant's questions.
 *
 * Always through here, never by reaching into ASKS: the variants and the
 * recognition that reads them back live together, and a question asked in
 * words the next turn cannot recognise is a question that gets asked twice.
 */
function ask(m: Memory, kind: AskKind): string {
  return voice(m).pick(`ask:${kind}`, ASKS[kind]);
}

/** Everything a turn needs besides the memory. */
interface Turn {
  m: Memory;
  digest: Digest;
  now: Date;
}

export function decide(system: string, state: ConversationState, now: Date): Decision {
  const digest = readDigest(system);
  // The vocabulary is this tenant's own range, read from the catalogue digest
  // it was given. Add a model to the catalogue and it is understood on the
  // next request; there is no list of model names in this code (spec §1).
  const m = remember(
    state.exchanges,
    { models: digest.models, brand: digest.brandName },
    state.previousCalls,
  );
  const turn: Turn = { m: m.intent === 'more' ? (inFull(state, digest, m, now) ?? m) : m, digest, now };

  const decision = state.steps.length > 0 ? continueTurn(turn, state.steps) : openTurn(turn);
  if (turn.m.expanded && decision.text) {
    decision.text = paragraphs(
      voice(m).pick('more:lead', ["Here's the full list:", 'Here they all are:', 'Of course, here is everything:']),
      decision.text,
    );
  }
  return finish(turn.m, decision);
}

/**
 * "Yes, show me the rest": the previous question, answered again in full.
 *
 * Tool calls are not replayed into the history (their results go stale), so
 * the list cannot be re-read from the last turn's calls. The customer's
 * previous message can: it is understood again, exactly as it was, and
 * answered with nothing cut short, so the full list is as current as the short
 * one was. Only a question that is answered by reading is re-asked. A previous
 * message that booked or sent something is never repeated.
 */
function inFull(state: ConversationState, digest: Digest, m: Memory, now: Date): Memory | undefined {
  if (state.exchanges.length < 2) return undefined;
  const previous = remember(
    state.exchanges.slice(0, -1),
    { models: digest.models, brand: digest.brandName },
    state.previousCalls,
  );
  const plan = openTurn({ m: previous, digest, now });
  if (plan.tools.length === 0 || !plan.tools.every((tool) => REREADABLE.has(tool.name))) return undefined;
  return { ...previous, seed: m.seed, asked: m.asked, expanded: true };
}

/* -------------------------------------------------------------------------- */
/* The last pass                                                               */
/* -------------------------------------------------------------------------- */

/** Said first when somebody swears in a genuine question, which is still answered. */
const KEEP_IT_FRIENDLY = [
  "Happy to help, though let's keep the language friendly.",
  "Of course, but let's keep it polite, please.",
  "No problem, though I'd appreciate it if we kept things friendly.",
] as const;

/** Said first when the same answer is about to go out twice in a row. */
const RECAP = [
  'Same as a moment ago, just to recap:',
  "Here it is again, in case it's useful:",
  'To recap:',
] as const;

/**
 * Every reply, just before it is sent.
 *
 *   swearing     a genuine question with a swear word in it is answered, after
 *                a light request to keep it friendly
 *   repetition   a reply identical to the previous one is introduced as a
 *                recap, instead of looking like the assistant is stuck
 *   em dashes    none reach a customer, whatever the catalogue text contains
 */
function finish(m: Memory, decision: Decision): Decision {
  if (decision.tools.length > 0 || !decision.text) return decision;
  const v = voice(m);
  let text = decision.text;

  if (m.latest.profane && m.intent !== 'abuse') {
    text = `${v.pick('friendly', KEEP_IT_FRIENDLY)} ${withoutOpener(text)}`;
  }

  if (m.asked && core(text) === core(m.asked)) {
    text = paragraphs(v.pick('recap', RECAP), text);
  }

  // A salam expects its reply, even when the same message also asked for a
  // test drive. The greeting reply already returns it.
  if (m.latest.salam && m.intent !== 'greeting' && !text.startsWith('Waalaikumsalam')) {
    text = `Waalaikumsalam! ${text}`;
  }

  text = text.replace(/\s*—\s*/g, ', ').replace(/–/g, ' to ');
  return { ...decision, text };
}

/** A reply without its opening courtesy, for comparing two replies' substance. */
function withoutOpener(text: string): string {
  const opener = OPENERS.find((o) => text.startsWith(`${o} `));
  return opener ? text.slice(opener.length + 1) : text;
}

function core(text: string): string {
  const recap = RECAP.find((r) => text.startsWith(r));
  return withoutOpener(recap ? text.slice(recap.length) : text)
    .replace(/\s+/g, ' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Opening move                                                               */
/* -------------------------------------------------------------------------- */

function openTurn(turn: Turn): Decision {
  const { m, digest, now } = turn;
  const v = voice(m);

  // Before anything is looked up: messages that must not be answered as they
  // were asked.
  switch (m.intent) {
    case 'abuse':
      return say(abuseReply(m));
    case 'injection':
      return say(
        v.pick('injection', [
          "I'm here to help with our cars and the dealership, so I'll stick to that. What would you like to know?",
          "That's not something I can help with, but I'm very happy to talk about the range, prices or booking a drive.",
        ]),
      );
    case 'privacy':
      return say(
        v.pick('privacy', [
          "I'm afraid I can't share anything about other customers, and I look after your details in exactly the same way. Is there anything about our cars I can help you with?",
          "I can't discuss other customers, sorry. Their details stay private, just as yours do. What can I help you with?",
        ]),
      );
    default:
      break;
  }

  // Asked about a car we do not build, say so and name what we do. The spec is
  // explicit about this (§"What you may state as fact"), and it is a far better
  // answer than "I do not have that confirmed" — which is true, but leaves the
  // customer wondering whether the Z9 exists and we are simply unsure.
  const invented = m.intent === 'competitor' ? undefined : inventedModel(m, digest);
  if (invented) {
    return say(
      paragraphs(
        sentences(
          v.pick('invented', [
            `We don't make ${article(invented)} ${invented}, I'm afraid.`,
            `There's no ${invented} in our range, sorry.`,
            `We don't build ${article(invented)} ${invented}.`,
          ]),
          `Here's everything ${digest.brandName} does make:`,
        ),
        range(digest),
        v.pick('invented:next', ['Any of those catch your eye?', 'Shall I tell you about one of them?']),
      ),
    );
  }

  switch (m.intent) {
    // --- The conversation itself -------------------------------------------
    case 'greeting':
      return say(greeting(turn));

    case 'how_are_you':
      return say(
        sentences(
          v.pick('howareyou', [
            "I'm doing well, thank you for asking!",
            "All good here, thanks for asking!",
            "Very well, thank you!",
          ]),
          v.pick('howareyou:next', [
            'How can I help you today?',
            'What can I help you with?',
            'Are you looking at anything in particular?',
          ]),
        ),
      );

    case 'who_are_you':
      // Honest, always. Sounding human is the aim; claiming to be one is not.
      return say(
        paragraphs(
          v.pick('whoami', [
            `I'm ${digest.brandName}'s virtual assistant. I can answer questions about any of our cars, check what's in stock, work out finance and book you a test drive, any time of day.`,
            `I'm the ${digest.brandName} virtual assistant, here around the clock for questions about the range, prices, stock and test drives.`,
          ]),
          v.pick('whoami:human', [
            "If you'd rather speak to a person, just say and I'll bring in one of the team.",
            'And whenever you want a real person, say the word and I will get one of the team to pick it up.',
          ]),
        ),
      );

    case 'thanks':
      return say(
        sentences(
          v.pick('thanks', ["You're very welcome!", 'My pleasure.', 'Any time.', 'No trouble at all.', 'Glad I could help.']),
          v.pick('thanks:more', ANYTHING_ELSE),
        ),
      );

    case 'goodbye':
      return say(
        v.pick('bye', [
          `Thanks for chatting with ${digest.brandName}! If anything else comes up, just send a message. Have a lovely day.`,
          'It was a pleasure. Whenever you have another question, I am here. Take care!',
          "Thanks for stopping by! I'm here whenever you need me. Have a great day.",
        ]),
      );

    case 'acknowledge':
      return say(
        sentences(
          v.pick('ack', ['Glad that helps.', 'Great.', 'Perfect.', 'Lovely.', 'Brilliant.']),
          m.modelSlug && v.sometimes('ack:car', 2)
            ? `Anything else you'd like to know about the ${modelShortName(m, digest)}?`
            : v.pick('ack:more', ANYTHING_ELSE),
        ),
      );

    case 'compliment':
      return say(
        sentences(
          v.pick('compliment', ["That's very kind of you, thank you!", 'Thank you, that is lovely to hear!', 'Thanks so much!']),
          m.latest.modelSlugs.length
            ? v.pick('compliment:drive', OFFER_DRIVE)
            : v.pick('compliment:more', ANYTHING_ELSE),
        ),
      );

    case 'language':
      return say(
        v.pick('language', [
          "I work best in English, but I understand a fair bit of everyday Malay too, so ask whichever way is easiest and I'll reply in English.",
          "I reply in English, though I understand common Malay as well. Ask away!",
        ]),
      );

    case 'complaint':
      return complaintTurn(m);

    // --- The dealership -------------------------------------------------------
    case 'hours':
      return call(t('getDealershipHours', {}));

    case 'location':
    case 'about_company':
    case 'careers':
      return call(t('getDealershipInformation', {}));

    // --- Finding a car ----------------------------------------------------------
    case 'search_vehicles':
      return call(t('searchVehicles', searchInput(m)));

    case 'compare':
      return m.comparisonSlugs.length >= 2
        ? call(t('compareVehicles', { modelSlugs: m.comparisonSlugs.slice(0, 3) }))
        : say(
            paragraphs(
              v.pick('compare', [
                'Happy to. Which two should I put side by side?',
                'Sure thing. Which two shall I compare?',
                'Of course. Which pair did you want to look at?',
              ]),
              range(digest),
            ),
          );

    case 'range':
      return say(
        paragraphs(
          sentences(
            v.pick('range:opener', ['Absolutely.', 'Of course.', 'Sure thing.']),
            v.pick('range:lead', [
              `Here's the whole ${digest.brandName} range:`,
              `This is everything we build:`,
              `Here's the full line-up:`,
            ]),
          ),
          range(digest),
          v.pick('range:next', [
            'Say which one catches your eye and I can go into it.',
            "Point me at one and I'll tell you more.",
            'Which of those should I open up for you?',
          ]),
        ),
      );

    // A superlative with a measure behind it. The criterion is always set when
    // the intent is 'rank' — but a missing one is a question about "the best"
    // with nothing to rank on, which is the recommendation conversation.
    case 'rank':
      return m.rankCriterion
        ? call(
            t('rankModels', {
              criterion: m.rankCriterion,
              ...(m.latest.bodyStyle && !m.latest.family ? { bodyStyle: m.latest.bodyStyle } : {}),
            }),
          )
        : say(recommendReply(m, digest));

    case 'best_value':
      return m.modelSlug
        ? call(t('rankTrims', { modelSlug: m.modelSlug }))
        : say(
            paragraphs(
              sentences(
                v.pick('value:which', [
                  'Good question, and it varies from car to car.',
                  'Worth comparing properly, because the steps are not all the same value.',
                ]),
                ask(m, 'model'),
              ),
              range(digest),
            ),
          );

    case 'recommend':
      return say(recommendReply(m, digest));

    case 'competitor':
      return competitorTurn(m, digest);

    // A shape we do not build. Told plainly, with what we DO build underneath
    // it, which is the same courtesy the invented-model branch extends: the
    // customer learns the answer and their next question at the same time.
    case 'body_not_built':
      return say(
        paragraphs(
          sentences(
            v.pick('unbuilt', [
              `We don't build ${articleFor(m.unbuiltBody!)} ${m.unbuiltBody}, I'm afraid.`,
              `No ${m.unbuiltBody} in the range, sorry.`,
              `${digest.brandName} doesn't make ${articleFor(m.unbuiltBody!)} ${m.unbuiltBody}.`,
            ]),
            v.pick('unbuilt:next', ['Here is everything we do build:', 'This is what we do make:', 'Here is what we do build:']),
          ),
          range(digest),
        ),
      );

    // --- One car, one aspect ----------------------------------------------------
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

    case 'feature_check':
      return featureCheckTurn(m, digest);

    case 'transmission':
      return m.modelSlug
        ? call(t('getVehiclePowertrains', { modelSlug: m.modelSlug }))
        : say(paragraphs(`${ask(m, 'model')} I'll tell you what gearbox it has.`, range(digest)));

    case 'charging':
      return m.modelSlug
        ? call(t('getVehiclePowertrains', { modelSlug: m.modelSlug }))
        : call(t('searchVehicles', { powertrainKind: 'bev' }));

    case 'delivery':
      return m.modelSlug
        ? call(t('checkInventory', { modelSlug: m.modelSlug }))
        : say(paragraphs(`${ask(m, 'model')} I'll check what's ready now.`, range(digest)));

    case 'specs':
      return m.modelSlug
        ? call(t('getVehicle', { modelSlug: m.modelSlug }))
        : say(paragraphs(ask(m, 'model'), range(digest)));

    // --- Buying one ---------------------------------------------------------------
    case 'payment':
    case 'promotions':
    case 'insurance':
    case 'registration':
    case 'warranty':
    case 'used_cars':
    case 'home_delivery':
      return say(teamTopic(m, m.intent));

    case 'purchase':
      return purchaseTurn(m, digest);

    // --- Coming in ----------------------------------------------------------------
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

    // --- Replies to the assistant's own offers ------------------------------------
    case 'more':
      return moreTurn(m);

    case 'declined':
      return say(
        sentences(
          v.pick('declined', ['No problem at all.', 'Not a problem.', "That's absolutely fine.", 'Of course, no pressure at all.']),
          v.pick('declined:more', [
            "If anything else comes up, I'm right here.",
            'Anything else I can help with?',
            'Just shout if you think of anything else.',
          ]),
        ),
      );

    case 'consent_declined':
      return say(
        sentences(
          v.pick('consent:no', ['No problem at all.', "That's completely fine."]),
          "I won't pass your details on. I do need that to book anything in for you, so if you change your mind just let me know, or feel free to pop into the showroom whenever suits.",
        ),
      );

    case 'declined_time':
      return say(
        sentences(
          v.pick('time:no', ['No problem.', "That's fine."]),
          'The team can usually find something that suits.',
          v.pick('time:human', OFFER_HUMAN),
        ),
      );

    default:
      // Never a bare shrug. If THIS message named a car, we know a great deal
      // about it, and leading with that is a real answer to someone plainly
      // interested in it, with the offer to chase the detail riding on top.
      //
      // Only this message, though. `m.modelSlug` remembers every car named in
      // the conversation, which is right for "and what colours does it come
      // in?" and catastrophic here: once somebody had mentioned the S5, every
      // message this branch could not parse replied with the S5 overview.
      return m.latest.modelSlugs.length === 1
        ? call(t('getVehicle', { modelSlug: m.latest.modelSlugs[0]! }))
        : say(cannotHelp(m, digest));
  }
}

/* -------------------------------------------------------------------------- */
/* Conversation replies                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Hello, in the dealership's own time of day.
 *
 * "Good evening" at 9pm is a small thing that reads as somebody being there. A
 * salam is returned, because it is a greeting that expects its reply. And a
 * customer we already know is welcomed back by name.
 */
function greeting(turn: Turn): string {
  const { m, digest, now } = turn;
  const v = voice(m);

  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: digest.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now),
  );
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const hello = m.latest.salam
    ? 'Waalaikumsalam!'
    : v.pick('hello', [`${part}!`, 'Hello!', 'Hi there!', `${part}, and welcome!`]);
  const name = m.name ? ` ${firstName(m.name)}` : '';

  return sentences(
    name ? `${hello.replace(/!$/, '')},${name}!` : hello,
    v.pick('welcome', [
      `Welcome to ${digest.brandName}. I can talk you through any of our cars, prices and finance, what's in stock today, or book you a test drive.`,
      `Thanks for getting in touch with ${digest.brandName}. Ask me anything about the range, what things cost, what we have in stock, or booking a drive.`,
      `You're through to ${digest.brandName}. I'm here to help with the cars, prices, finance, stock and test drives.`,
    ]),
    v.pick('welcome:ask', ['What can I help you with today?', 'What are you looking for?', 'Where would you like to start?']),
  );
}

function abuseReply(m: Memory): string {
  const v = voice(m);
  if (m.latest.slur) {
    return v.pick('slur', [
      "I'm not able to continue with language like that. If there's anything about our cars or the dealership I can help with, I'm here.",
      "That's not language I can engage with. If you'd like help with a car, a price or a test drive, I'm happy to help.",
    ]);
  }
  if (m.abuseCount >= 3) {
    return v.pick('abuse:last', [
      "I'll leave it there for now. Whenever you'd like help with a car, just send a message and I'll be glad to help.",
      "Let's pick this up another time. When you're ready to talk cars, I'll be here.",
    ]);
  }
  return v.pick('abuse', [
    "I'd appreciate it if we could keep things friendly. I'm happy to help with anything about our cars, prices or booking a test drive.",
    "Let's keep it respectful, please. Is there anything about our cars I can help you with?",
    "I'm here to help, so let's keep it polite. What would you like to know about the range?",
  ]);
}

/**
 * "What should I buy?"
 *
 * Answered with a question, which is what a good salesperson does. The range
 * is several cars and the customer has told us nothing; listing all of them
 * with every figure attached is not help, it is a brochure.
 *
 * One question, with the possible answers named in it, so it takes a single
 * word to reply to. The answer is read back as a ranking criterion, so
 * "running costs" produces a real ordering of real figures on the next turn.
 */
function recommendReply(m: Memory, digest: Digest): string {
  const v = voice(m);
  return sentences(
    v.pick('rec:lead', [
      'Happy to help you narrow it down.',
      'I can definitely help with that.',
      "Let's find the right one for you.",
    ]),
    `There are ${count(digest.models.length)} in the range.`,
    ask(m, 'priority'),
  );
}

function competitorTurn(m: Memory, digest: Digest): Decision {
  // Our own car, if they named one: the comparison they want is not ours to
  // make, but what OUR car offers is, and it is the useful half.
  if (m.latest.modelSlugs.length > 0) {
    return call(t('getVehicle', { modelSlug: m.latest.modelSlugs[0]! }));
  }
  const v = voice(m);
  return say(
    paragraphs(
      v.pick('competitor', [
        `We're a ${digest.brandName} dealership, so I can only speak for our own cars. I won't compare against other brands, but I can tell you everything about ours.`,
        `I can only speak for ${digest.brandName}, so I'll leave other brands to them! Here's what we build:`,
      ]),
      range(digest),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Questions the catalogue does not answer                                     */
/* -------------------------------------------------------------------------- */

/**
 * Topics that are real, common, and not in any catalogue: warranty terms,
 * insurance, road tax, current offers, pre-owned stock, delivery, payment
 * methods.
 *
 * Each gets a warm, specific lead-in — never "I don't know" — and a real offer
 * to put the question to a person, which a "yes" turns into a ticket with the
 * customer's own words on it.
 */
const TOPICS: Record<
  'payment' | 'promotions' | 'insurance' | 'registration' | 'warranty' | 'used_cars' | 'home_delivery',
  readonly string[]
> = {
  payment: [
    "You can pay in full or spread the cost with finance, and I can work out a monthly figure for any car right now. For accepted payment methods and deposits, the team will confirm the details.",
    'Paying in full and paying on finance both work, and I can give you a monthly estimate straight away. The team can confirm which payment methods they take and how deposits work.',
  ],
  promotions: [
    "Offers change from month to month, so the team is the best source for what's running right now.",
    "Good timing to ask! What's on offer changes regularly, so I'd rather the team told you the current ones than I gave you an out of date one.",
  ],
  insurance: [
    "Insurance depends on you as much as the car, so that one's best handled by the team.",
    "Insurance isn't something I can quote here, but the team can point you in the right direction.",
  ],
  registration: [
    'Registration and road tax vary a little from car to car, so the team will give you the exact figures.',
    "Good question. On-the-road costs depend on the car and how it's registered, so the team will confirm them for you.",
  ],
  warranty: [
    "Warranty cover varies by model, so I'd rather the team confirmed the exact terms than gave you a rough version.",
    'Good question. The exact warranty terms are worth hearing properly, so the team will confirm them for you.',
  ],
  used_cars: [
    "I look after our new range and what's in stock. For pre-owned cars, the team will know what's come in.",
    "I'm set up for the new range, so for pre-owned cars the team is the one to ask.",
  ],
  home_delivery: [
    'Delivery is something the team arranges when you buy, depending on where you are.',
    "We can certainly talk about getting the car to you. The team sorts out the details when you buy.",
  ],
};

/** One explanation and one offer: the team is mentioned once, not three times. */
function teamTopic(m: Memory, topic: keyof typeof TOPICS): string {
  const v = voice(m);
  return sentences(v.pick(`topic:${topic}`, TOPICS[topic]), v.pick('topic:offer', TEAM_OFFER_TAILS));
}

/**
 * An offer to put the question to somebody who can answer it.
 *
 * Deliberately built on one of the GET_IT_RIGHT lines and one of the team
 * offer tails, because that is how the next turn recognises a "yes please" as
 * accepting THIS offer. The wording is a promise the code keeps: say yes and a
 * ticket is raised with the question on it.
 */
function offerToAsk(m: Memory, about: string, hedge = true): string {
  const v = voice(m);
  return sentences(
    hedge ? v.pick('offer:lead', GET_IT_RIGHT) : '',
    `${about}, ${v.pick('offer:team', OFFER_TEAM)}.`,
    v.pick('offer:ask', TEAM_OFFER_TAILS),
  );
}

/**
 * The reply when nothing else fits.
 *
 * What it must never be is a dead end: a customer who gets "I don't know" and
 * nothing else closes the window, and the dealership never learns they were
 * there. So it says what it CAN do, concretely, and offers a person.
 *
 * And it must never be a loop. The second miss in a row asks them to put it
 * another way, with examples; the third stops guessing and offers someone from
 * the team, because by then the kindest thing is a human.
 */
function cannotHelp(m: Memory, digest: Digest): string {
  const v = voice(m);
  // Examples in this dealership's own words: the first two cars it builds.
  const [first, second] = digest.models.map((model) => shortModel(model.name));
  const unsure = v.pick('unsure', UNSURE);

  if (m.unsureStreak >= 2) {
    return sentences(
      unsure,
      "I don't want to keep you going round in circles.",
      v.pick('unsure:human', OFFER_HUMAN),
    );
  }

  if (m.unsureStreak === 1) {
    return paragraphs(
      sentences(unsure, 'Could you try putting it another way? For example:'),
      [
        first ? `- "How much is the ${first}?"` : '- "What cars do you have?"',
        `- "What colours does the ${second ?? first ?? 'car'} come in?"`,
        '- "Can I book a test drive on Saturday?"',
      ].join('\n'),
      sentences(`Or, if it's something else, ${v.pick('cannot:team', OFFER_TEAM)}.`, v.pick('cannot:offer', TEAM_OFFER_TAILS)),
    );
  }

  return paragraphs(
    sentences(unsure, v.pick('cannot:can', ["Here's what I can help with:", 'These are the things I can help with straight away:'])),
    [
      '- Prices, trims, engines and colours for any model',
      "- What's in stock right now",
      '- Finance estimates',
      '- Booking a test drive',
      '- Our opening hours and where to find us',
    ].join('\n'),
    sentences(`For anything else, ${v.pick('cannot:team', OFFER_TEAM)}.`, v.pick('cannot:offer', TEAM_OFFER_TAILS)),
  );
}

/* -------------------------------------------------------------------------- */
/* Everything that needs to know which car                                     */
/* -------------------------------------------------------------------------- */

function catalogueTurn(m: Memory, digest: Digest): Decision {
  if (m.intent === 'finance' && m.financeApplication) return financeRequestTurn(m, digest);

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
  if (!slug) return say(paragraphs(ask(m, 'model'), range(digest)));

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
    case 'price':
      // All three are per trim and powertrain, so the codes have to be looked
      // up before they can be asked for. An option standard on one trim is a
      // paid extra on another; there is no answer without the pair.
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

/**
 * "Does it have heated seats?" needs the build first — equipment is per trim
 * and engine — and then both the standard list and the options list, because
 * the honest answer might be "yes, as an option".
 */
function featureCheckTurn(m: Memory, digest: Digest): Decision {
  if (!m.modelSlug) {
    // A third row with no car named is a family-sized question, and the SUVs
    // are where the room is.
    if (m.featureTerms.includes('third row')) return call(t('searchVehicles', { bodyStyle: 'suv' }));
    return say(
      paragraphs(
        `${ask(m, 'model')} I'll check whether it has ${sentenceList(m.featureTerms.map(featureName), 'or')}.`,
        range(digest),
      ),
    );
  }
  return call(
    t('getVehiclePowertrains', { modelSlug: m.modelSlug }),
    t('getVehicleTrims', { modelSlug: m.modelSlug }),
  );
}

function featureName(term: string): string {
  const names: Record<string, string> = {
    carplay: 'Apple CarPlay',
    'android auto': 'Android Auto',
    'head-up display': 'a head-up display',
    'third row': 'a third row of seats',
    towing: 'a tow bar',
    camera: 'a camera',
    display: 'a touchscreen',
  };
  return names[term] ?? term;
}

function searchInput(m: Memory): Record<string, unknown> {
  return {
    ...(m.bodyStyle ? { bodyStyle: m.bodyStyle } : {}),
    ...(m.budgetCents ? { maxPriceCents: m.budgetCents } : {}),
    ...(m.electric ? { powertrainKind: 'bev' } : m.hybrid ? { powertrainKind: 'hybrid' } : {}),
    ...(m.awd ? { drivetrain: 'awd' } : {}),
  };
}

/**
 * The diary window to ask for.
 *
 * The day the customer named, if they named one — "this weekend", "tomorrow",
 * "Saturday" — so the times offered are the times they asked about. Otherwise
 * the window the previous turn used, so that the slot somebody picked from a
 * list is still in the list when their name and number arrive and it is
 * booked. Otherwise the next fortnight.
 */
function slotsCall(m: Memory, digest: Digest, now: Date): ToolCall {
  const named = requestedWindow(m.said.at(-1) ?? '', now, digest.timezone);
  const previous = m.previousCalls.find((c) => c.name === 'getAvailableTestDriveSlots');
  const window =
    named ??
    (previous && typeof previous.input.fromDate === 'string' && typeof previous.input.toDate === 'string'
      ? { fromDate: previous.input.fromDate, toDate: previous.input.toDate }
      : { fromDate: localDate(now, digest.timezone), toDate: localDate(now, digest.timezone, 14) });

  return t('getAvailableTestDriveSlots', {
    ...(m.modelSlug ? { modelSlug: m.modelSlug } : {}),
    ...window,
  });
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function requestedWindow(
  said: string,
  now: Date,
  timezone: string,
): { fromDate: string; toDate: string } | undefined {
  const lower = said.toLowerCase();
  const today = WEEKDAYS.indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(now).toLowerCase(),
  );
  const day = (offset: number) => localDate(now, timezone, offset);
  const until = (weekday: number) => (weekday - today + 7) % 7;

  if (/\b(today|tonight|later today)\b/.test(lower)) return { fromDate: day(0), toDate: day(0) };
  if (/\b(tomorrow|tmrw|tmr|esok)\b/.test(lower)) return { fromDate: day(1), toDate: day(1) };
  if (/\b(weekend|wkend)\b/.test(lower)) {
    const saturday = today === 0 ? -1 : until(6);
    return { fromDate: day(Math.max(0, saturday)), toDate: day(saturday + 1) };
  }
  if (/\bnext week\b/.test(lower)) {
    const monday = until(1) || 7;
    return { fromDate: day(monday), toDate: day(monday + 6) };
  }
  const named = WEEKDAYS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(lower));
  if (named >= 0) return { fromDate: day(until(named)), toDate: day(until(named)) };
  return undefined;
}

/** Read tools a "show me all of them" may re-run. Never a write. */
const REREADABLE = new Set([
  'searchVehicles', 'getVehicleTrims', 'getVehicleColours', 'getVehiclePowertrains',
  'getVehicleOptions', 'getVehicleFeatures', 'rankModels', 'rankTrims', 'checkInventory', 'compareVehicles',
]);

/**
 * "Yes, show me the rest."
 *
 * The previous turn's lookups are run again rather than remembered, so the
 * full list is as current as the short one was — and only reads are ever
 * re-run, so accepting this offer can never repeat a booking.
 */
function moreTurn(m: Memory): Decision {
  const reads = m.previousCalls.filter((c) => REREADABLE.has(c.name));
  if (reads.length === 0) {
    return say(`${voice(m).pick('more:which', ['Which list would you like in full?', 'Sure, which would you like to see all of?'])}`);
  }
  return call(...reads.map((c) => t(c.name, c.input)));
}

/* -------------------------------------------------------------------------- */
/* Continuing a turn, once tools have returned                                */
/* -------------------------------------------------------------------------- */

function continueTurn(turn: Turn, steps: Step[]): Decision {
  const { m, digest } = turn;

  // A failed tool ends the turn. Carrying on would mean pricing a build from a
  // list that never arrived.
  const failed = steps.find((step) => step.isError);
  if (failed) return say(describe(failed, context(turn)));

  // The full version of a list the previous reply cut short. Nothing to work
  // out: show the last lookup, all of it.
  if (m.intent === 'more') {
    const last = steps.at(-1)!;
    return say(paragraphs(voice(m).pick('more:lead', ["Here's the full list:", 'Here they all are:', 'Of course, here is everything:']), describe(last, { ...context(turn), expanded: true })));
  }

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
    (m.bodyStyle || m.latest.electric || m.latest.awd || m.latest.hybrid) &&
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
    if (!m.modelSlug) return say(compose(turn, steps));

    const trim = resolveTrim(m.words, rowsOf<TrimRow>(steps, 'getVehicleTrims', 'trims'));
    const colour = resolveColour(m.colourWords, rowsOf<ColourRow>(steps, 'getVehicleColours', 'colours'));

    // A colour they named that this model is not painted in. Checking stock for
    // it would report "none available", which is true and misleading.
    if (m.colourWords.length > 0 && !colour) {
      return say(
        paragraphs(
          `We don't offer ${aColour(m.colourWords[0]!)} on the ${modelShortName(m, digest)}, I'm afraid.`,
          describe(steps.find((step) => step.name === 'getVehicleColours')!, context(turn)),
        ),
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
        ? `The ${build.trim.name} comes with the ${sentenceList(build.alternatives, 'or')}.`
        : "I don't have another engine listed for that trim.";
      return say(
        sentences(
          `The ${build.powertrain.name} isn't offered on the ${build.trim.name}, I'm afraid.`,
          offered,
          "Tell me which you'd like and I'll price it for you.",
        ),
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
      if (m.intent === 'feature_check') {
        // Equipment differs by trim, so "does it have heated seats?" is
        // answered for every trim — "standard on the Premium and Luxury" is the
        // true answer, and checking only the cheapest would have said "no".
        const trims = rowsOf<TrimRow>(steps, 'getVehicleTrims', 'trims');
        const powertrains = rowsOf<PowertrainRow>(steps, 'getVehiclePowertrains', 'powertrains');
        const named = resolveTrim(m.words, trims);
        const targets = (named ? [named] : trims)
          .map((trim) => ({
            trim,
            powertrain:
              named && build.named
                ? build.powertrainCode
                : powertrains.find((row) => row.offeredWithTrims.includes(trim.code))?.code,
          }))
          .filter((target): target is { trim: TrimRow; powertrain: string } => Boolean(target.powertrain));
        return call(
          ...targets.flatMap(({ trim, powertrain }) => {
            const build = { modelSlug: m.modelSlug!, powertrainCode: powertrain, trimCode: trim.code };
            return [t('getVehicleFeatures', build), t('getVehicleOptions', build)];
          }),
        );
      }
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
        const v = voice(m);
        return say(
          paragraphs(
            sentences(
              opener(m, v),
              from ? `The ${modelShortName(m, digest)} starts at **${from}**.` : '',
            ),
            describe(steps.find((step) => step.name === 'getVehicleTrims')!, context(turn)),
            v.pick('price:next', [
              "Tell me which trim and engine you're interested in and I'll price it exactly.",
              "If you've got a trim and engine in mind, I can give you the exact figure.",
              'Want me to price up a particular version for you?',
            ]),
          ),
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
    if (cents && m.financeApplication && m.name && m.email && m.consent) {
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
    return bookingTurn(turn, steps);
  }

  return say(compose(turn, steps));
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
  competitor: 'getVehicle',
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

/** Answers that are good news, and so can open with "Absolutely." */
const WARM: ReadonlySet<string> = new Set([
  'getVehiclePowertrains', 'getVehicleTrims', 'getVehicleColours',
  'getVehicleOptions', 'getVehicleFeatures', 'calculateVehiclePrice', 'compareVehicles',
  'rankModels', 'rankTrims', 'calculateFinanceEstimate', 'getDealershipHours',
  'getDealershipInformation', 'searchVehicles',
]);

/** The words a describe() call needs that only the conversation knows. */
function context(turn: Turn): DescribeContext {
  const { m, digest, now } = turn;
  return {
    seed: m.seed,
    avoid: m.asked,
    modelName: m.modelSlug ? digest.models.find((model) => model.slug === m.modelSlug)?.name : undefined,
    firstName: m.name ? firstName(m.name) : undefined,
    email: m.email,
    phone: m.phone,
    now,
    expanded: m.expanded,
  };
}

function compose(turn: Turn, steps: Step[]): Decision['text'] {
  const { m, digest } = turn;
  const last = steps.at(-1);
  if (!last) return cannotHelp(m, digest);
  const ctx = context(turn);
  const v = voice(m);

  // Answers assembled from more than one lookup.
  if (m.intent === 'feature_check') {
    const trimNames = new Map(
      rowsOf<TrimRow>(steps, 'getVehicleTrims', 'trims').map((trim) => [trim.code, trim.name]),
    );
    const perTrim = steps
      .filter((s) => s.name === 'getVehicleFeatures')
      .map((features) => {
        const code = String(features.input.trimCode ?? '');
        return {
          trimName: trimNames.get(code) ?? code,
          features,
          options: steps.find((s) => s.name === 'getVehicleOptions' && s.input.trimCode === code),
        };
      });
    const check = describeFeatureCheck(m.featureTerms, m.latest.words, perTrim, ctx);
    return paragraphs(
      check.text,
      check.found
        ? v.pick('fc:drive', OFFER_DRIVE)
        : offerToAsk(m, 'On that specific piece of kit', false),
    );
  }

  if (m.intent === 'charging' && last.name === 'getVehiclePowertrains') {
    const charging = describeCharging(last, ctx);
    return paragraphs(
      charging.text,
      charging.electric
        ? sentences('Charging times depend on the charger as much as the car.', offerToAsk(m, 'For times at home and on a fast charger', false))
        : v.pick('charge:more', ANYTHING_ELSE),
    );
  }

  if (m.intent === 'transmission' && last.name === 'getVehiclePowertrains') {
    return paragraphs(describeTransmission(last, ctx), v.pick('trans:more', ANYTHING_ELSE));
  }

  if (m.intent === 'about_company' && last.name === 'getDealershipInformation') {
    return aboutCompany(m, digest, describe(last, ctx));
  }

  if (m.intent === 'careers' && last.name === 'getDealershipInformation') {
    return paragraphs(
      "I'm set up for customer enquiries, so I can't help with jobs directly, but the team can point you in the right direction.",
      describe(last, ctx),
    );
  }

  const answer = answerStep(m, steps) ?? last;
  const body = describe(answer, ctx);

  // A preamble is a caveat — "we don't offer green", "nothing under that
  // budget" — and nobody says "Absolutely!" in front of bad news.
  const caveat = preamble(m, answer, digest);
  const text = body || cannotHelp(m, digest);
  return paragraphs(
    caveat ? paragraphs(caveat, text) : inline(warmOpener(m, answer), text),
    followUp(m, answer),
  );
}

/**
 * The one step worth reading out.
 *
 * In order: the tool this intent was asking for, then any tool whose result is
 * an answer in its own right. LAST matching call, not the first: a turn can
 * call one tool twice — a budget search that finds nothing is immediately
 * re-run without the budget — and the second call is the one that answers.
 */
function answerStep(m: Memory, steps: Step[]): Step | undefined {
  const reversed = [...steps].reverse();
  const wanted = ANSWERS_TO[m.intent];
  const asked = wanted && reversed.find((step) => step.name === wanted && !step.isError);
  if (asked) return asked;
  return reversed.find((step) => ANSWERS.has(step.name) && !step.isError);
}

/** "Absolutely. The S5 comes in..." — the courtesy on the same line as the answer. */
function inline(opener: string, text: string): string {
  if (!opener) return text;
  const [first, ...rest] = text.split('\n\n');
  return paragraphs(`${opener} ${first}`, ...rest);
}

/** "Absolutely." in front of good news, most of the time, never twice running. */
function opener(m: Memory, v: Voice): string {
  // The full list already has its own lead line ("Here they all are:").
  if (m.latest.profane || m.expanded) return '';
  return v.sometimes('no-opener', 3) ? '' : v.pick('opener', OPENERS);
}

function warmOpener(m: Memory, answer: Step): string {
  if (!WARM.has(answer.name) || answer.isError) return '';
  if (answer.name === 'searchVehicles' && foundNothing(answer)) return '';
  if (answer.name === 'rankModels' && (answer.result as { enough?: boolean })?.enough === false) return '';
  // An overview for a question it cannot fully answer opens with the car, not
  // with "Absolutely": the customer asked something else first.
  if (answer.name === 'getVehicle' && ['unknown', 'competitor', 'specs'].includes(m.intent)) return '';
  return opener(m, voice(m));
}

function foundNothingInStock(step: Step): boolean {
  const result = (step.result ?? {}) as { available?: unknown[] };
  return !Array.isArray(result.available) || result.available.length === 0;
}

function foundNothing(step: Step): boolean {
  const result = (step.result ?? {}) as { count?: unknown };
  return result.count === 0;
}

/** Said before the answer, where the answer alone would not address the question. */
function preamble(m: Memory, last: Step, digest: Digest): string {
  if (last.name === 'searchVehicles' && m.budgetCents && !foundNothing(last)) {
    const searched = (last.input.maxPriceCents ?? null) === null;
    // The second, wider search. The figure comes from what they said, and the
    // prices below it come from the catalogue.
    if (searched) return "Nothing in the range comes in under that, I'm afraid. Here's the closest we build:";
  }

  if (last.name === 'searchVehicles' && m.family && !m.budgetCents && !foundNothing(last)) {
    return 'For a family, our SUVs are the natural place to start.';
  }

  if (last.name === 'searchVehicles' && m.intent === 'charging') {
    return 'These are the ones you plug in:';
  }

  if (last.name === 'getVehicleColours' && !last.isError && m.colourWords.length > 0) {
    const offered = resolveColour(m.colourWords, rowsOf<ColourRow>([last], 'getVehicleColours', 'colours'));
    // A list of nine, none of them theirs. Saying so is the answer; the list is
    // the useful part that follows it. Decided by the palette, not by a
    // hardcoded idea of which colours a dealership sells.
    if (!offered) {
      return `We don't offer ${aColour(m.colourWords[0]!)} on the ${modelShortName(m, digest)}, I'm afraid. Here is what we do:`;
    }
  }

  if (last.name === 'getVehicle' && m.intent === 'competitor') {
    return "I can only speak for our own cars, so I won't compare against other brands. Here's what ours brings:";
  }
  return '';
}

function aColour(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

/** One next step, offered only where there is an obvious one. */
function followUp(m: Memory, last: Step): string {
  const v = voice(m);

  if (last.name === 'calculateFinanceEstimate') return ask(m, 'finance');

  if (last.name === 'checkInventory' && !last.isError) {
    // Two different questions land here. "What's in stock" is answered by the
    // list; "how soon can I have one" is only half answered by it, because a
    // factory order's timing is not in any catalogue and must not be invented.
    // And nothing on site is a question about what is coming, not a moment to
    // offer a drive.
    if (m.intent === 'delivery') return offerToAsk(m, 'On build and delivery times for an order');
    if (foundNothingInStock(last)) return offerToAsk(m, "On what's arriving and when");
    return v.pick('stock:drive', OFFER_DRIVE);
  }

  if (last.name === 'getVehicle') {
    // The catalogue does not hold boot volumes or tow ratings, and this is
    // where that is handled honestly: real information about the car, then a
    // route to the figure — never a shrug, and never an invented number.
    if (m.intent === 'specs') return offerToAsk(m, 'On that exact figure');
    if (m.intent === 'unknown') return offerToAsk(m, 'On the specifics you asked about');
    if (m.intent === 'competitor') return v.pick('competitor:drive', OFFER_DRIVE);
    if (m.intent === 'vehicle_overview') {
      return v.sometimes('overview:drive', 3)
        ? v.pick('overview:drive', OFFER_DRIVE)
        : v.pick('overview:next', [
            'I can go into the engines, the trims, the colours or what we have in stock. Just say which.',
            "Engines, trims, colours, what's on site: say which and I'll open it up.",
            "Would you like the engines, the trims, the colours, or what's here right now?",
          ]);
    }
  }

  if (last.name === 'getDealershipHours' || last.name === 'getDealershipInformation') {
    return v.sometimes('visit:drive', 2) ? v.pick('visit:drive', OFFER_DRIVE) : v.pick('visit:more', ANYTHING_ELSE);
  }

  if (last.name === 'searchVehicles' && !foundNothing(last)) {
    return v.pick('search:next', [
      'Want me to tell you more about any of them?',
      'Say which one appeals and I will open it up.',
      'Any of those worth a closer look?',
    ]);
  }

  if (last.name === 'getVehicleTrims' || last.name === 'getVehiclePowertrains' || last.name === 'getVehicleColours') {
    return v.sometimes(`${last.name}:next`, 2) ? v.pick('aspect:drive', OFFER_DRIVE) : '';
  }

  if (last.name === 'rankModels' || last.name === 'rankTrims') {
    return v.sometimes('rank:next', 2) ? v.pick('rank:drive', OFFER_DRIVE) : '';
  }

  return '';
}

/**
 * Who we are, from the range and the showroom's own details.
 *
 * The range is summarised from the catalogue digest — how many cars, the
 * smallest to the largest, how many are electric — and the rest comes from
 * the dealership information the tool returned. No history, no founding date,
 * no "family-run since": nothing the dealership has not written down.
 */
function aboutCompany(m: Memory, digest: Digest, contact: string): string {
  const v = voice(m);
  const models = digest.models;
  const electric = models.filter((model) => /electric/i.test(model.segment)).length;
  const first = models[0];
  const lastModel = models.at(-1);

  return paragraphs(
    sentences(
      v.pick('about:lead', ['Happy to tell you about us!', "We'd love to tell you about us!"]),
      `${digest.brandName} builds ${count(models.length)} cars${first && lastModel ? `, from the ${first.name}, our ${softCase(first.segment)}, to the ${lastModel.name}, our ${softCase(lastModel.segment)}` : ''}.`,
      electric ? `${capitalise(count(electric))} of them ${electric === 1 ? 'is' : 'are'} fully electric.` : '',
    ),
    contact,
    v.pick('about:next', ['What can I help you find?', 'Is there a particular car you are interested in?']),
  );
}

/* -------------------------------------------------------------------------- */
/* Booking                                                                     */
/* -------------------------------------------------------------------------- */

interface Slot {
  startsAt: string;
  label: string;
}

function bookingTurn(turn: Turn, steps: Step[]): Decision {
  const { m, digest, now } = turn;
  const slots = slotsFrom(steps);
  const v = voice(m);
  const lookups = steps.filter((step) => step.name === 'getAvailableTestDriveSlots');

  // Nothing on the day they named — often simply a day we are closed. That is
  // not "nothing in the next two weeks": widen to the fortnight once, and say
  // plainly that their day was full before offering the nearest alternatives.
  const widened = lookups.length > 1;
  if (slots.length === 0 && !widened) {
    const input = lookups[0]?.input ?? {};
    const fortnight = { fromDate: localDate(now, digest.timezone), toDate: localDate(now, digest.timezone, 14) };
    if (input.fromDate !== fortnight.fromDate || input.toDate !== fortnight.toDate) {
      return call(
        t('getAvailableTestDriveSlots', {
          ...(m.modelSlug ? { modelSlug: m.modelSlug } : {}),
          ...fortnight,
        }),
      );
    }
  }

  if (slots.length === 0) {
    // Not a dead end: a booking needs a specialist AND a demonstrator free, and
    // when neither is, the enquiry still has to reach a person.
    const missing = askContact(
      m,
      "I'm sorry, there's nothing free in the next two weeks: a specialist and a demonstrator both have to be available. I can ask the team to find you a time.",
      { phone: true },
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

  const narrowed = narrowSlots(slots, m, turn);
  const chosen = narrowed.length === 1 ? narrowed[0]! : undefined;

  if (!chosen) {
    const model = m.modelSlug ? ` for the ${modelShortName(m, digest)}` : '';
    return say(
      paragraphs(
        widened
          ? v.pick('slots:widened', [
              `Nothing's free then, I'm afraid. Here are the nearest times I have${model}:`,
              `That day's not available, sorry. These are the next free slots${model}:`,
            ])
          : narrowed.length > 1
          ? v.pick('slots:narrowed', [`Here's what's free then${model}:`, `These times work then${model}:`])
          : v.pick('slots:lead', [
              `${v.pick('slots:opener', ['Lovely!', 'Brilliant!', 'Great choice!'])} Here are the next available times${model}:`,
              `Happy to book that in. These are the next free slots${model}:`,
            ]),
        offer(narrowed.length > 0 ? narrowed.slice(0, 5) : spread(slots)),
        ask(m, 'time'),
      ),
    );
  }

  const missing = askContact(m, `${shortLabel(chosen.label)} works perfectly.`, { phone: true });
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
  // The latest lookup: after a widened search, that is the one with the times.
  const step = [...steps].reverse().find((s) => s.name === 'getAvailableTestDriveSlots');
  const result = (step?.result ?? {}) as { slots?: unknown };
  return Array.isArray(result.slots)
    ? (result.slots as Slot[]).filter((s) => typeof s?.startsAt === 'string')
    : [];
}

function offer(slots: Slot[]): string {
  return slots
    .slice(0, 5)
    .map((slot, index) => `${index + 1}. ${shortLabel(slot.label)}`)
    .join('\n');
}

/**
 * "Wednesday, September 23 at 9am" rather than "Wednesday, September 23, 2026
 * at 9:00 a.m. EDT" five times over.
 *
 * The year and the zone are right on a confirmation and noise in a list of
 * choices. Falls back to the full label for any format it does not recognise,
 * and the slot is always matched back by its full label, so shortening the
 * words can never change which time is booked.
 */
function shortLabel(label: string): string {
  const match =
    /^(\w+), (\w+) (\d{1,2}), \d{4} at (\d{1,2}):(\d{2})[\s\u202f\u00a0]*([ap])\.?[\s\u202f\u00a0]?m\.?/i.exec(label);
  if (!match) return label;
  const [, weekday, month, day, hour, minute, half] = match;
  return `${weekday}, ${month} ${day} at ${hour}${minute === '00' ? '' : `:${minute}`}${half!.toLowerCase()}m`;
}

/**
 * Up to five times, no more than two on any one day.
 *
 * The diary's first five slots are usually one morning, and five choices on a
 * single Wednesday is not a choice for somebody who works on Wednesdays.
 */
function spread(slots: Slot[]): Slot[] {
  const perDay = new Map<string, number>();
  const picked: Slot[] = [];
  for (const slot of slots) {
    const day = slot.label.split(' at ')[0] ?? slot.label;
    const used = perDay.get(day) ?? 0;
    if (used >= 2) continue;
    perDay.set(day, used + 1);
    picked.push(slot);
    if (picked.length === 5) break;
  }
  return picked.length > 0 ? picked : slots.slice(0, 5);
}

/**
 * Which of the offered times the customer meant.
 *
 * Returns every slot still in play rather than a single guess: "Saturday" with
 * three Saturday slots is a narrowing, not a choice, and booking one of them
 * would be inventing a decision the customer never made.
 */
function narrowSlots(slots: Slot[], m: Memory, turn: Turn): Slot[] {
  if (m.chosenSlotLabel) {
    // If the time they picked has since been taken, this is empty and the
    // customer is asked again rather than booked into a different slot.
    return slots.filter(
      (slot) => slot.label === m.chosenSlotLabel || shortLabel(slot.label) === m.chosenSlotLabel,
    );
  }

  for (const said of [...m.said].reverse()) {
    const matched = slots.filter((slot) => saidMatchesSlot(slot.label, said));
    if (matched.length > 0) return matched;
    const relative = relativeSlots(said, slots, turn);
    if (relative.length > 0) return relative;
  }
  return [];
}

/**
 * "Tomorrow afternoon", "this weekend", "today" — times said the way people
 * say them.
 *
 * Worked out in the dealership's own time zone from the clock the turn was
 * answered at, and kept to the NEAREST such day: "tomorrow" in a two-week
 * diary is one date, not both Thursdays.
 */
function relativeSlots(said: string, slots: Slot[], turn: Turn): Slot[] {
  const lower = said.toLowerCase();
  const weekday = (offset: number) =>
    new Intl.DateTimeFormat('en-US', { timeZone: turn.digest.timezone, weekday: 'long' }).format(
      new Date(turn.now.getTime() + offset * 86_400_000),
    );

  const days: string[] = [];
  if (/\b(today|tonight|later today)\b/.test(lower)) days.push(weekday(0));
  if (/\b(tomorrow|tmrw|tmr|esok)\b/.test(lower)) days.push(weekday(1));
  const weekend = /\b(weekend|wkend)\b/.test(lower);
  if (weekend) days.push('Saturday', 'Sunday');

  const part =
    /\bmorning\b/.test(lower) ? 'morning'
      : /\bafternoon\b/.test(lower) ? 'afternoon'
        : /\b(evening|after work)\b/.test(lower) ? 'evening'
          : undefined;

  if (days.length === 0 && !part) return [];

  let pool = days.length ? slots.filter((slot) => days.some((day) => slot.label.startsWith(day))) : slots;

  if (days.length) {
    // The nearest occurrence only: one date, or the first weekend's two.
    const dates = [...new Set(pool.map((slot) => slot.label.split(' at ')[0]!))].slice(0, weekend ? 2 : 1);
    pool = pool.filter((slot) => dates.includes(slot.label.split(' at ')[0]!));
  }
  if (part) pool = pool.filter((slot) => partOfDay(slot.label) === part);
  return pool;
}

function partOfDay(label: string): 'morning' | 'afternoon' | 'evening' | undefined {
  const match = /at (\d{1,2}):\d{2}[\s\u202f\u00a0]*([ap])/i.exec(label);
  if (!match) return undefined;
  const hour = Number(match[1]) % 12 + (match[2]!.toLowerCase() === 'p' ? 12 : 0);
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

/* -------------------------------------------------------------------------- */
/* Requests that need contact details                                          */
/* -------------------------------------------------------------------------- */

/**
 * The gate in front of every write tool.
 *
 * Asks for exactly what is missing — never for a name somebody gave two
 * messages ago — and, when an answer could not be read, says so rather than
 * repeating the question word for word.
 *
 * Consent is a yes to a question about being contacted. An email address is an
 * identifier, not a permission, so giving one is never treated as agreeing to
 * anything (spec §19, docs/08-security-review.md).
 */
function askContact(m: Memory, lead: string, need: { phone?: boolean } = {}): Decision | undefined {
  const v = voice(m);
  const missing = {
    name: !m.name,
    email: !m.email,
    phone: Boolean(need.phone) && !m.phone,
  };

  if (missing.name || missing.email || missing.phone) {
    const kind: AskKind =
      missing.name && missing.email && missing.phone ? 'contactPhone'
        : missing.name && missing.email ? 'contact'
          : missing.name && missing.phone ? 'namePhone'
            : missing.email && missing.phone ? 'emailPhone'
              : missing.name ? 'name'
                : missing.email ? 'email'
                  : 'phone';

    // Already asked for exactly this, and still nothing we could read.
    const retry = askedLastTime(m, kind) ? RETRIES[kind] : undefined;
    const question = retry ? v.pick(`retry:${kind}`, retry) : ask(m, kind);

    // Half-way through giving details, the lead is a thank-you, not the
    // original sentence again.
    const midway = askedForContact(m.asked);
    const thanks = m.name
      ? `${v.pick('contact:thanks', GOT_IT).replace(/\.$/, '')}, ${firstName(m.name)}.`
      : v.pick('contact:thanks', GOT_IT);

    return say(sentences(midway && !retry ? thanks : retry ? '' : lead, question));
  }

  if (!m.consent) {
    return say(`${v.pick('consent:lead', GOT_IT).replace(/\.$/, '')}, ${firstName(m.name!)}. ${ask(m, 'consent')}`);
  }
  return undefined;
}

const CONTACT_ASKS: AskKind[] = ['contact', 'contactPhone', 'name', 'email', 'phone', 'emailPhone', 'namePhone'];

function askedForContact(text: string): boolean {
  return CONTACT_ASKS.some((kind) => ASKS[kind].some((q) => text.includes(q)));
}

function askedLastTime(m: Memory, kind: AskKind): boolean {
  if (kind !== 'email' && kind !== 'phone') return false;
  return (
    ASKS[kind].some((q) => m.asked.includes(q)) ||
    (RETRIES[kind] ?? []).some((q) => m.asked.includes(q))
  );
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
  const first = name.split(/\s+/)[0] ?? name;
  return first.startsWith('@') ? name : first;
}

function cancelTurn(m: Memory): Decision {
  if (!m.confirmationCode || !m.email) {
    return say(
      sentences(
        voice(m).pick('cancel', ["Of course, I can sort that out.", 'No problem at all.', 'Easily done.']),
        ask(m, 'code'),
      ),
    );
  }
  return call(t('cancelTestDrive', { confirmationCode: m.confirmationCode, email: m.email }));
}

function callbackTurn(m: Memory): Decision {
  const missing = askContact(m, voice(m).pick('callback', ON_IT), { phone: true });
  if (missing) return missing;

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
        ? `${ask(m, 'appraisal')} What's ${sentenceList(missingDetails)} of the ${known}?`
        : `${ask(m, 'appraisal')} ${ask(m, 'vehicle')}`,
    );
  }
  if (!vehicle.condition) return say(ask(m, 'condition'));

  const missing = askContact(m, 'Thank you, that is everything I need about the car.');
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
  const missing = askContact(
    m,
    m.latest.negotiating || m.negotiating
      ? voice(m).pick('handoff:price', [
          "Pricing is one for our sales specialists: they're the ones who can talk you through what's possible.",
          "I'll leave the numbers to our sales specialists, who can go through what's possible with you.",
        ])
      : voice(m).pick('handoff:lead', [
          "Of course. I'll get one of our specialists onto this.",
          'Absolutely, let me bring in one of our specialists.',
          "Certainly. I'll pass you to one of our specialists.",
        ]),
  );
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
 * Ready to buy. The hottest message a dealership gets, and it goes straight
 * to a salesperson with the car and the customer's own words attached.
 */
function purchaseTurn(m: Memory, digest: Digest): Decision {
  const v = voice(m);
  const model = m.modelSlug ? ` on the ${modelShortName(m, digest)}` : '';
  const missing = askContact(
    m,
    sentences(
      v.pick('buy:lead', [`Brilliant, let's get that moving${model}!`, `Wonderful news${model ? `, the ${modelShortName(m, digest)} is a great choice` : ''}!`, "That's great to hear!"]),
      "I'll get one of our sales specialists to take you through the next steps.",
    ),
    { phone: true },
  );
  if (missing) return missing;

  return call(
    t('requestHumanHandoff', {
      ...contactInput(m),
      reason: reasonFrom(m, `Ready to buy${m.modelSlug ? ` the ${modelShortName(m, digest)}` : ''}.`),
      department: 'sales',
    }),
  );
}

/**
 * A complaint. Apologised for, then handed to a person — never argued with,
 * and never answered by the assistant on the dealership's behalf.
 */
function complaintTurn(m: Memory): Decision {
  const missing = askContact(
    m,
    voice(m).pick('complaint:lead', [
      "I'm really sorry to hear that. I'll make sure a manager hears about it and gets back to you personally.",
      "I'm sorry, that's not the experience we want anyone to have. Let me get a manager to look into it for you.",
    ]),
  );
  if (missing) return missing;

  return call(
    t('requestHumanHandoff', {
      ...contactInput(m),
      reason: reasonFrom(m, 'Customer complaint.'),
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

  const missing = askContact(m, 'Our service team can definitely help with that.');
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
  const missing = askContact(
    m,
    voice(m).pick('ticket:lead', ["Of course, I'll pass it to the team.", 'Leave it with me, I will get that to the team.']),
  );
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
  const missing = askContact(m, "Great, I'll get a finance specialist to confirm the terms.");
  if (missing) return missing;
  if (!m.modelSlug) return say(paragraphs(ask(m, 'model'), range(digest)));

  // The price is re-read rather than remembered: the request must record what
  // the catalogue says today, not what was quoted three turns ago.
  return call(t('getVehicle', { modelSlug: m.modelSlug }));
}

function reasonFrom(m: Memory, fallback: string): string {
  const said = m.said.at(-1)?.trim();
  return said && said.length > 8 ? said.slice(0, 500) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

/** "the S5", as a salesperson says it, from the catalogue's own name. */
function modelShortName(m: Memory, digest: Digest): string {
  const name = digest.models.find((model) => model.slug === m.modelSlug)?.name;
  return name ? shortModel(name) : 'car';
}

/** "Premium Electric SUV" mid-sentence: lower case, but SUV stays SUV. */
function softCase(text: string): string {
  return text.replace(/\b([A-Z][a-z]+)\b/g, (word) => word.toLowerCase());
}

/** "Sinclair S5" is "S5" in conversation. */
function shortModel(name: string): string {
  const words = name.trim().split(/\s+/);
  return words.length > 1 ? words.slice(1).join(' ') : name;
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
  if (m.latest.modelSlugs.length > 0) return undefined;

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
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
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
