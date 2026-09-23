import type Anthropic from '@anthropic-ai/sdk';
import {
  understand, nameFromReply, phoneFromReply, findConfirmationCode, findTradeInVehicle,
  chosenFromOffer, colourWords, criterionFromReply,
  type Intent, type RankCriterion, type Timeframe, type TradeInVehicle, type Vocabulary,
} from './understand';
import { seedFrom, OFFER_DRIVE, OFFER_HUMAN, MORE_TAILS } from './voice';

/**
 * What the conversation has established, read back out of the messages.
 *
 * The rule-based assistant keeps no state of its own. Everything it knows it
 * re-derives from the same message list the model would be given, which means
 * a restart, a retry or a second server cannot disagree about where a booking
 * had got to.
 */

/** One customer message, together with whatever the assistant had just asked. */
export interface Exchange {
  asked: string;
  said: string;
}

/** A tool called during THIS turn, paired with what it returned. */
export interface Step {
  name: string;
  input: Record<string, unknown>;
  result: unknown;
  isError: boolean;
}

/** A tool call, without its result. */
export interface Call {
  name: string;
  input: Record<string, unknown>;
}

export interface ConversationState {
  exchanges: Exchange[];
  steps: Step[];
  /**
   * The tools the PREVIOUS turn called.
   *
   * Kept for one thing: "yes, show me the rest" after a shortened list. The
   * list is re-read rather than remembered, so the full version is as current
   * as the short one was.
   */
  previousCalls: Call[];
}

export function readConversation(messages: Anthropic.MessageParam[]): ConversationState {
  const exchanges: Exchange[] = [];
  let steps: Step[] = [];
  let turnCalls: Call[] = [];
  let previousCalls: Call[] = [];
  const pending = new Map<string, Call>();
  let lastAssistant = '';

  for (const message of messages) {
    if (typeof message.content === 'string') {
      if (message.role === 'assistant') {
        lastAssistant = message.content;
        continue;
      }
      // A plain customer message starts a turn. Anything a previous turn's
      // tools returned is finished business and must not steer this one.
      exchanges.push({ asked: lastAssistant, said: message.content });
      steps = [];
      previousCalls = turnCalls;
      turnCalls = [];
      continue;
    }

    for (const block of message.content) {
      if (block.type === 'text' && message.role === 'assistant') {
        lastAssistant = block.text;
      } else if (block.type === 'tool_use') {
        const call = { name: block.name, input: (block.input ?? {}) as Record<string, unknown> };
        pending.set(block.id, call);
        turnCalls.push(call);
      } else if (block.type === 'tool_result') {
        const use = pending.get(block.tool_use_id);
        if (!use) continue;
        steps.push({
          name: use.name,
          input: use.input,
          result: parseResult(block.content),
          isError: block.is_error === true,
        });
      }
    }
  }

  return { exchanges, steps, previousCalls };
}

function parseResult(content: Anthropic.ToolResultBlockParam['content']): unknown {
  const text =
    typeof content === 'string'
      ? content
      : (content ?? [])
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * What the assistant is doing, which is not always what the last message
 * classified as.
 *
 *   ticket            accepted an offer to pass an unanswered question on
 *   more              "yes" to "want to see them all?"
 *   declined          "no thanks" to an offer or a question
 *   consent_declined  "no" to being contacted — which ends a booking politely
 *                     rather than asking again
 *   declined_time     none of the offered times suit
 */
export type Flow =
  | Intent
  | 'ticket'
  | 'more'
  | 'declined'
  | 'consent_declined'
  | 'declined_time';

/**
 * Everything the customer has told us, accumulated across the conversation.
 *
 * Later mentions win: a customer who says "the S5" and then "actually, the E5"
 * means the E5. Contact details are the exception — they are kept once given,
 * because a later message that happens not to repeat an email address is not a
 * retraction of it.
 */
export interface Memory {
  intent: Flow;
  /** What the latest message alone said, before history is folded in. */
  latest: ReturnType<typeof understand>;
  said: string[];
  /** The assistant's previous message. Also what fresh phrasing avoids repeating. */
  asked: string;
  /**
   * Which phrasings this turn uses, as a number.
   *
   * Plain data, derived from the conversation, so it belongs here with
   * everything else the conversation determines. Anything holding a Memory can
   * build a Voice from it, and the same conversation always reads the same way
   * — which is what keeps a varied assistant testable.
   */
  seed: number;
  /** Which axis a ranking question asked for. Only ever set alongside 'rank'. */
  rankCriterion?: RankCriterion;
  /** A shape they asked for that this catalogue cannot hold. This turn only. */
  unbuiltBody?: string;
  modelSlug?: string;
  comparisonSlugs: string[];
  /**
   * Content words from the whole conversation, newest first.
   *
   * Resolved against real trims, colours and powertrains when the tools come
   * back. Nothing here is assumed to name anything until the catalogue agrees
   * that it does.
   */
  words: string[];
  colourWords: string[];
  /** Equipment named in the latest message, for a "does it have" question. */
  featureTerms: string[];
  budgetCents?: number;
  bodyStyle?: ReturnType<typeof understand>['bodyStyle'];
  electric?: boolean;
  hybrid?: boolean;
  awd?: boolean;
  family?: boolean;
  name?: string;
  email?: string;
  phone?: string;
  /** Explicit. Never inferred from the customer having given an email address. */
  consent: boolean;
  /**
   * They accepted the offer of a finance specialist.
   *
   * Remembered rather than re-read from the last message, because the messages
   * that follow it are a name, an email and a yes to being contacted — none of
   * which mention financing, and all of which are part of the same request.
   */
  financeApplication: boolean;
  termMonths?: number;
  timeframe?: Timeframe;
  financeInterest?: boolean;
  tradeInInterest?: boolean;
  negotiating?: boolean;
  justBrowsing?: boolean;
  seats?: number;
  confirmationCode?: string;
  /** The exact time the customer picked, as it was worded when offered. */
  chosenSlotLabel?: string;
  tradeIn: TradeInVehicle;
  /** The last thing asked that no tool could answer, kept for the ticket body. */
  openQuestion?: string;
  /** How many messages in this conversation were abusive. */
  abuseCount: number;
  /**
   * How many of the assistant's most recent replies, in a row, were "I'm not
   * sure what you mean". The third one in a row is a person, not another
   * guess — a loop is worse than admitting it.
   */
  unsureStreak: number;
  /** The previous turn's tools, for re-reading a list in full. */
  previousCalls: Call[];
  /** Set when the customer said yes to something the assistant offered. */
  acceptedOffer?: OfferKind;
  /**
   * Answer in full: every item, not a shortlist. Set when the customer said
   * yes to "want to see the rest?", and the previous question is answered
   * again with nothing held back.
   */
  expanded?: boolean;
}

/** Intents that span several turns, so a bare "yes" still belongs to one. */
const FLOWS: Flow[] = [
  'test_drive', 'cancel', 'callback', 'trade_in', 'human', 'finance', 'service',
  'purchase', 'complaint',
];

/**
 * Questions the assistant answers by offering the team, so the ticket that a
 * "yes" raises has to carry the customer's own words.
 */
const OPEN_QUESTIONS: Intent[] = [
  'unknown', 'specs', 'warranty', 'insurance', 'registration', 'promotions',
  'used_cars', 'home_delivery', 'payment', 'delivery', 'feature_check', 'charging',
];

/** A message with no intent of its own: an answer, an acknowledgement, a "yes". */
const NO_INTENT_OF_ITS_OWN: Intent[] = ['unknown', 'thanks', 'greeting', 'acknowledge'];

export function remember(
  exchanges: Exchange[],
  vocabulary?: Vocabulary,
  previousCalls: Call[] = [],
): Memory {
  const latest = understand(exchanges.at(-1)?.said ?? '', vocabulary);
  const asked = exchanges.at(-1)?.asked ?? '';

  const memory: Memory = {
    intent: latest.intent,
    latest,
    said: exchanges.map((e) => e.said),
    asked,
    // Both halves matter. The turn number moves the wording on as the
    // conversation goes, so two questions in a row do not come back in
    // identical clothes; the message itself means two different customers
    // asking the same thing are not read the same reply word for word.
    seed: seedFrom(exchanges.length, exchanges.at(-1)?.said ?? ''),
    rankCriterion: latest.rankCriterion,
    unbuiltBody: latest.unbuiltBody,
    comparisonSlugs: [],
    words: [],
    colourWords: [],
    featureTerms: latest.featureTerms,
    consent: false,
    financeApplication: false,
    tradeIn: {},
    abuseCount: 0,
    unsureStreak: unsureStreak(exchanges),
    previousCalls,
  };

  const flows: Flow[] = [];

  for (const exchange of exchanges) {
    const turn = understand(exchange.said, vocabulary);
    if (FLOWS.includes(turn.intent)) flows.push(turn.intent);
    if (turn.intent === 'abuse') memory.abuseCount += 1;

    // A "yes" to something the assistant offered starts what it offered. Read
    // for every exchange, not only the last, so a flow started by accepting an
    // offer is still the flow three messages later when they give their email.
    const accepted = acceptance(exchange.asked, turn);
    if (accepted === 'ticket') flows.push('ticket');
    if (accepted === 'drive') flows.push('test_drive');
    if (accepted === 'human') flows.push('human');

    // A reply to one of our own questions is an answer, not a new question. A
    // contact detail recorded as "the thing we could not answer" would put
    // someone's name in front of staff as their enquiry.
    //
    // 'specs' counts as an open question as much as 'unknown' does. A tow
    // rating or a boot volume is recognised as a question about the car — which
    // is what lets the reply be useful — but it is still the question staff
    // need to see on the ticket, word for word, so they can answer THAT rather
    // than ring somebody up and ask what they wanted.
    if (
      OPEN_QUESTIONS.includes(turn.intent) &&
      !isAsk(exchange.asked) &&
      exchange.said.trim().length >= 8
    ) {
      memory.openQuestion = exchange.said.trim();
    }

    if (turn.modelSlugs.length === 1) memory.modelSlug = turn.modelSlugs[0];
    if (turn.modelSlugs.length > 1) {
      memory.comparisonSlugs = turn.modelSlugs;
      memory.modelSlug = turn.modelSlugs[0];
    }
    // Newest first, so a later "actually, the Sport" resolves ahead of an
    // earlier "Premium" when both match a real trim.
    memory.words = [...turn.words, ...memory.words];
    const colours = colourWords(exchange.said);
    if (colours.length > 0) memory.colourWords = [...colours, ...memory.colourWords];

    if (turn.budgetCents) memory.budgetCents = turn.budgetCents;
    if (turn.timeframe) memory.timeframe = turn.timeframe;
    if (turn.financeInterest) memory.financeInterest = true;
    if (turn.tradeInInterest) memory.tradeInInterest = true;
    if (turn.negotiating) memory.negotiating = true;
    if (turn.justBrowsing) memory.justBrowsing = true;
    if (turn.seats) memory.seats = turn.seats;
    if (turn.bodyStyle) memory.bodyStyle = turn.bodyStyle;
    if (turn.electric) memory.electric = true;
    if (turn.hybrid) memory.hybrid = true;
    if (turn.awd) memory.awd = true;
    if (turn.family) memory.family = true;
    if (turn.termMonths) memory.termMonths = turn.termMonths;
    if (turn.email) memory.email = turn.email;
    if (turn.phone) memory.phone = turn.phone;
    if (turn.name) memory.name = turn.name;

    const code = findConfirmationCode(exchange.said);
    if (code) memory.confirmationCode = code;

    if (askedFor(exchange.asked, 'time')) {
      const chosen = chosenFromOffer(exchange.asked, exchange.said);
      if (chosen) memory.chosenSlotLabel = chosen;
    }

    // A phone number counts loosely — seven digits, the length of a Brunei
    // number — only straight after the assistant asked for one.
    if (!turn.phone && asksForPhone(exchange.asked)) {
      const offered = phoneFromReply(exchange.said);
      if (offered) memory.phone = offered;
    }

    // A name only counts loosely when the assistant had just asked for one,
    // and only when the reply is not itself a question: "Saturday instead"
    // after "what name should I put down?" is a change of plan, not a name.
    if (!turn.name && asksForName(exchange.asked) && NO_INTENT_OF_ITS_OWN.includes(turn.intent)) {
      const offered = nameFromReply(exchange.said);
      if (offered) memory.name = offered;
    }

    if (askedFor(exchange.asked, 'finance') && turn.affirmative) memory.financeApplication = true;
    if (/\b(apply|application|pre.?approv|proceed with financ|sort out financ)\b/i.test(exchange.said)) {
      memory.financeApplication = true;
    }

    // Consent is a yes to a direct question about being contacted, and nothing
    // else. An email address is an identifier, never a permission (spec §19).
    if (askedFor(exchange.asked, 'consent') && turn.affirmative) memory.consent = true;
    if (/\b(you can|feel free to|happy to be|happy for you to)\s+(contact|call|email|reach)/i.test(exchange.said)) {
      memory.consent = true;
    }

    const vehicle = findTradeInVehicle(exchange.said);
    if (vehicle.year) memory.tradeIn.year = vehicle.year;
    if (vehicle.make) memory.tradeIn.make = vehicle.make;
    if (vehicle.model) memory.tradeIn.model = vehicle.model;
    if (vehicle.mileageKm !== undefined) memory.tradeIn.mileageKm = vehicle.mileageKm;
    if (vehicle.condition) memory.tradeIn.condition = vehicle.condition;
  }

  // --- What THIS message means, given what the assistant just said ---------

  // The assistant asked what matters most and they answered it. That is a
  // ranking question, even though nothing in the reply is a superlative, and a
  // customer who answers the question they were asked should never be told it
  // was not understood.
  //
  // Read from the LAST exchange only. An answer given five turns ago is not
  // still the subject, and applying it inside the loop would make every later
  // message a ranking question too.
  const answeredPriority = askedFor(asked, 'priority')
    ? criterionFromReply(exchanges.at(-1)?.said ?? '')
    : undefined;

  if (answeredPriority) {
    memory.intent = 'rank';
    memory.rankCriterion = answeredPriority;
    return memory;
  }

  const bare = NO_INTENT_OF_ITS_OWN.includes(latest.intent) || latest.intent === 'goodbye';

  // A "no" to a question or an offer. Said plainly, it is an answer, and the
  // worst possible reply to it is the same question again.
  if (bare && latest.negative && latest.short && asked) {
    if (askedFor(asked, 'consent')) {
      memory.intent = 'consent_declined';
      return memory;
    }
    if (askedFor(asked, 'time')) {
      memory.intent = 'declined_time';
      return memory;
    }
    if (offerIn(asked) || isAsk(asked)) {
      memory.intent = 'declined';
      return memory;
    }
  }

  // A "yes" to an offer.
  const accepted = bare ? acceptance(asked, latest) : undefined;
  if (accepted) {
    memory.acceptedOffer = accepted;
    memory.intent =
      accepted === 'drive' ? 'test_drive'
        : accepted === 'more' ? 'more'
          : accepted === 'human' ? 'human'
            : 'ticket';
    return memory;
  }

  // A customer answering a question is not changing the subject. When the last
  // message carries no intent of its own, the flow it is answering continues.
  if (bare && latest.intent !== 'goodbye' && asked && flows.length > 0 && isAsk(asked)) {
    memory.intent = flows.at(-1)!;
    return memory;
  }

  // "Yes" with nothing on the table to say yes to is agreement, not a question
  // the assistant failed to understand. Treated as an acknowledgement.
  if (latest.intent === 'unknown' && latest.affirmative && latest.short && !isAsk(asked)) {
    memory.intent = 'acknowledge';
  }

  return memory;
}

/* -------------------------------------------------------------------------- */
/* The assistant's own questions                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every wording of every question the assistant asks.
 *
 * These are memory keys as much as sentences. The next turn decides whether
 * the customer answered a question or changed the subject by looking for the
 * assistant's own words in its previous message — so a phrasing that is not
 * listed here is a question whose answer will not be understood.
 *
 * Which is why variants live in ONE place. Adding a way to ask for a phone
 * number without adding it here produces an assistant that asks, is answered,
 * and asks again — the single most infuriating thing a bot does.
 *
 * Contact questions come in combinations, so the assistant only ever asks for
 * what it does not already have. Asking for a name somebody gave two messages
 * ago is how a conversation starts to feel like a form.
 */
export const ASKS = {
  contact: [
    'Could I take your name and email address?',
    'What name and email should I put down?',
    'Can I grab your name and email?',
    'Who shall I put that down for? Name and email is all I need.',
  ],
  contactPhone: [
    'Could I take your name, email and the best number to reach you on?',
    "What's your name, email and a good contact number?",
    "Who shall I book that under? I'll need a name, an email address and a phone number.",
    'Can I grab your name, email and mobile number?',
  ],
  name: [
    'And what name should I put it under?',
    'And who am I booking this for?',
    'Could I take your name as well?',
  ],
  email: [
    'And what email address should I use?',
    "What's the best email for you?",
    'Could I take your email address as well?',
  ],
  phone: [
    'What number should the team call you on?',
    "What's the best number to reach you on?",
    'Which number should they ring?',
    'And a contact number, in case we need to reach you on the day?',
  ],
  emailPhone: [
    "What's your email address and the best number to reach you on?",
    'Could I take your email and a contact number?',
  ],
  namePhone: [
    'Could I take your name and a contact number?',
    "What's your name and the best number to reach you on?",
  ],
  consent: [
    'Are you happy for the team to contact you about this?',
    "Is it all right if the team gets in touch about this?",
    'Happy for someone to contact you about it?',
  ],
  time: [
    'Which of those times suits you?',
    'Which one works for you?',
    'Any of those any good?',
    'Which would you like?',
  ],
  model: [
    'Which model did you have in mind?',
    'Which one were you looking at?',
    'Which car did you mean?',
  ],
  code: [
    "What's the confirmation code on your booking, and the email address it was made with?",
    "Could you give me the confirmation code and the email it was booked with?",
  ],
  /**
   * The appraisal lead-in.
   *
   * The vehicle question that follows is phrased from whatever is still
   * missing, so its wording moves. This fragment is what makes the next
   * message readable as an answer rather than a change of subject.
   */
  appraisal: [
    'Happy to get that appraised.',
    'We can get that appraised.',
    'I can get that looked at for you.',
  ],
  vehicle: [
    "What's the year, make, model and rough mileage of your current car?",
    'What are you driving at the moment? Year, make, model and rough mileage.',
    'Tell me the year, make, model and roughly the mileage?',
  ],
  condition: [
    'How would you describe its condition? Excellent, good, fair or poor.',
    'What sort of condition is it in? Excellent, good, fair or poor.',
  ],
  /**
   * What matters most, asked when they want a recommendation.
   *
   * One question, with the axes named, because "what are you looking for?" is
   * a question nobody can answer and this one takes a word to reply to.
   */
  priority: [
    'What matters most to you: price, power, running costs, or electric range?',
    'What are you weighing up most: the price, the performance, the running costs, or the range?',
    "What are you leaning on most: cost, pace, economy, or range?",
    'Which of those matters most: what it costs, how quick it is, what it drinks, or how far it goes?',
  ],
  finance: [
    'Would you like a specialist to confirm the terms?',
    'Want someone to confirm the actual terms?',
    'Shall I get a specialist to firm those numbers up?',
  ],
} as const satisfies Record<string, readonly string[]>;

export type AskKind = keyof typeof ASKS;

/**
 * Second attempts, for when an answer could not be read.
 *
 * Recognised as the same question — so the answer to a retry is understood —
 * but worded to say what went wrong, instead of repeating the first question
 * word for word at somebody who thinks they already answered it.
 */
export const RETRIES: Partial<Record<AskKind, readonly string[]>> = {
  email: [
    "That email doesn't look quite complete. Could you check it? Something like name@example.com.",
    "I couldn't quite read that as an email address. Could you send it again?",
  ],
  phone: [
    "I didn't quite catch a number there. What's the best phone number to reach you on?",
    'Could you send the number again, digits only? That one did not come through clearly.',
  ],
};

/**
 * Said when the assistant did not understand the message.
 *
 * Listed, like the asks, because the next turn has to recognise it: the offer
 * that follows is what turns into a ticket, and "yes please" means nothing
 * without knowing what it answered. Also counted: three in a row, and the
 * assistant stops guessing and offers a person.
 */
export const UNSURE = [
  "I'm not quite sure I followed that one.",
  "I didn't quite catch what you're after there.",
  "Sorry, I'm not sure I understood.",
  "I don't think I've understood that correctly.",
] as const;

/**
 * Said when a question is understood but the catalogue does not hold the
 * answer: a tow rating, a boot volume, a warranty term.
 *
 * The WORDING matters more than it looks. "I don't have that confirmed" is
 * true and useless — it tells the customer about our database when they asked
 * about a car, and it reads as a shrug. These say the same thing from the
 * customer's side: the answer is worth getting right, and it is being got.
 * Nothing here promises a figure we do not have; it promises a person who
 * does, which is a promise this code then actually keeps by raising a ticket.
 */
export const GET_IT_RIGHT = [
  "I'd rather get you a proper answer on that than a half one.",
  'Let me get you the exact answer on that rather than my best guess.',
  "I want to get that one exactly right for you, so let me not guess at it.",
  "That's worth getting right rather than roughly right.",
  "I'd sooner check that than tell you something that turns out to be wrong.",
] as const;

/** Every line that means "I could not answer that", for recognition. */
export const CANNOT_HELP = [...UNSURE, ...GET_IT_RIGHT] as const;

/**
 * The question that ends an offer to pass something to the team.
 *
 * A "yes" is matched to the LAST offer in the assistant's message, so these
 * tails are what place the team offer at the end of it.
 */
export const TEAM_OFFER_TAILS = [
  'Shall I pass it on?',
  'Would you like me to pass it along?',
  'Want me to hand it over to them?',
  'Shall I get them to come back to you?',
  'Want me to put it to them?',
  'Shall I ask them for you?',
  'Shall I get them onto it?',
  'Want me to have them come back to you with it?',
] as const;

export function askedFor(assistantText: string, kind: AskKind): boolean {
  return (
    ASKS[kind].some((ask) => assistantText.includes(ask)) ||
    (RETRIES[kind] ?? []).some((ask) => assistantText.includes(ask))
  );
}

/** True when the assistant's last message admitted it could not answer. */
export function saidCannotHelp(assistantText: string): boolean {
  return CANNOT_HELP.some((line) => assistantText.includes(line));
}

/** True when the assistant's last message said it did not understand. */
export function saidUnsure(assistantText: string): boolean {
  return UNSURE.some((line) => assistantText.includes(line));
}

/** True when the assistant's last message was waiting for an answer. */
function isAsk(assistantText: string): boolean {
  return (
    saidCannotHelp(assistantText) ||
    (Object.keys(ASKS) as AskKind[]).some((kind) => askedFor(assistantText, kind))
  );
}

function asksForPhone(assistantText: string): boolean {
  return (['phone', 'contactPhone', 'emailPhone', 'namePhone'] as const).some((kind) =>
    askedFor(assistantText, kind),
  );
}

function asksForName(assistantText: string): boolean {
  return (['contact', 'contactPhone', 'name', 'namePhone'] as const).some((kind) =>
    askedFor(assistantText, kind),
  );
}

/* -------------------------------------------------------------------------- */
/* Offers                                                                      */
/* -------------------------------------------------------------------------- */

export type OfferKind = 'drive' | 'more' | 'human' | 'ticket';

const OFFERS: Record<OfferKind, readonly string[]> = {
  drive: OFFER_DRIVE,
  more: MORE_TAILS,
  human: OFFER_HUMAN,
  ticket: [...CANNOT_HELP, ...TEAM_OFFER_TAILS],
};

/**
 * The offer a "yes" would be accepting: the one that appears LAST.
 *
 * A reply can carry more than one — a car's details with a drive offer in the
 * middle and a "want to see them all?" at the end — and the question nearest
 * the end is the one a person answers with "yes".
 */
export function offerIn(assistantText: string): OfferKind | undefined {
  let best: { kind: OfferKind; at: number } | undefined;
  for (const [kind, phrases] of Object.entries(OFFERS) as [OfferKind, readonly string[]][]) {
    for (const phrase of phrases) {
      const at = assistantText.lastIndexOf(phrase);
      if (at >= 0 && (!best || at > best.at)) best = { kind, at };
    }
  }
  return best?.kind;
}

/** The offer this message accepted, if it was a plain yes to one. */
function acceptance(
  asked: string,
  turn: ReturnType<typeof understand>,
): OfferKind | undefined {
  if (!asked || !turn.affirmative) return undefined;
  if (!NO_INTENT_OF_ITS_OWN.includes(turn.intent)) return undefined;
  return offerIn(asked);
}

/** How many of the assistant's latest replies, in a row, said it did not understand. */
function unsureStreak(exchanges: Exchange[]): number {
  let streak = 0;
  for (const exchange of [...exchanges].reverse()) {
    if (!saidUnsure(exchange.asked)) break;
    streak += 1;
  }
  return streak;
}
