import type Anthropic from '@anthropic-ai/sdk';
import {
  understand, nameFromReply, findConfirmationCode, findTradeInVehicle, chosenFromOffer,
  colourWords, criterionFromReply,
  type Intent, type RankCriterion, type Timeframe, type TradeInVehicle, type Vocabulary,
} from './understand';
import { seedFrom } from './voice';

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

export interface ConversationState {
  exchanges: Exchange[];
  steps: Step[];
}

export function readConversation(messages: Anthropic.MessageParam[]): ConversationState {
  const exchanges: Exchange[] = [];
  let steps: Step[] = [];
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
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
      continue;
    }

    for (const block of message.content) {
      if (block.type === 'text' && message.role === 'assistant') {
        lastAssistant = block.text;
      } else if (block.type === 'tool_use') {
        pending.set(block.id, {
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
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

  return { exchanges, steps };
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
 * Everything the customer has told us, accumulated across the conversation.
 *
 * Later mentions win: a customer who says "the S5" and then "actually, the E5"
 * means the E5. Contact details are the exception — they are kept once given,
 * because a later message that happens not to repeat an email address is not a
 * retraction of it.
 */
/**
 * What the assistant is doing, which is not always what the last message
 * classified as: 'ticket' is a flow the customer enters by accepting an offer
 * to pass an unanswered question on, not something they ever say outright.
 */
export type Flow = Intent | 'ticket';

export interface Memory {
  intent: Flow;
  /** What the latest message alone said, before history is folded in. */
  latest: ReturnType<typeof understand>;
  said: string[];
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
  budgetCents?: number;
  bodyStyle?: ReturnType<typeof understand>['bodyStyle'];
  electric?: boolean;
  awd?: boolean;
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
}

/** Intents that span several turns, so a bare "yes" still belongs to one. */
const FLOWS: Intent[] = [
  'test_drive', 'cancel', 'callback', 'trade_in', 'human', 'finance', 'service',
];

export function remember(exchanges: Exchange[], vocabulary?: Vocabulary): Memory {
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
    comparisonSlugs: [],
    words: [],
    colourWords: [],
    consent: false,
    financeApplication: false,
    tradeIn: {},
  };

  const flows: Flow[] = [];

  for (const exchange of exchanges) {
    const turn = understand(exchange.said, vocabulary);
    if (FLOWS.includes(turn.intent)) flows.push(turn.intent);

    // Accepting the offer to pass a question on is what starts a ticket.
    if (saidCannotHelp(exchange.asked) && turn.affirmative) flows.push('ticket');

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
      (turn.intent === 'unknown' || turn.intent === 'specs') &&
      !isAsk(exchange.asked) &&
      exchange.said.trim().length >= 12
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
    if (turn.awd) memory.awd = true;
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

    // A name only counts loosely when the assistant had just asked for one.
    if (!turn.name && askedFor(exchange.asked, 'contact')) {
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

  // A customer answering a question is not changing the subject. When the last
  // message carries no intent of its own, the flow it is answering continues.
  const carryOn = latest.intent === 'unknown' || latest.intent === 'thanks' || latest.intent === 'greeting';
  if (carryOn && asked && flows.length > 0 && isAsk(asked)) {
    memory.intent = flows.at(-1)!;
  }

  return memory;
}

/**
 * The assistant's own questions, recognised by their wording.
 *
 * Both sides of this conversation are written here, so matching on the exact
 * phrasing is reliable in a way that matching on a model's output would not be.
 */
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
 */
export const ASKS = {
  contact: [
    'Could I take your name and email address?',
    'What name and email should I put down?',
    'Can I grab your name and email?',
    'Who am I booking that for — name and email?',
  ],
  consent: [
    'Are you happy for the team to contact you about this?',
    "Is it all right if the team gets in touch about this?",
    'Happy for someone to contact you about it?',
  ],
  phone: [
    'What number should the team call you on?',
    "What's the best number to reach you on?",
    'Which number should they ring?',
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
    "What are you driving at the moment — year, make, model and rough mileage?",
    'Tell me the year, make, model and roughly the mileage?',
  ],
  condition: [
    'How would you describe its condition — excellent, good, fair or poor?',
    'What sort of condition is it in — excellent, good, fair or poor?',
  ],
  /**
   * What matters most, asked when they want a recommendation.
   *
   * One question, with the axes named, because "what are you looking for?" is
   * a question nobody can answer and this one takes a word to reply to.
   */
  priority: [
    'What matters most to you — price, power, running costs, or electric range?',
    'What are you weighing up most — the price, the performance, the running costs, or the range?',
    "What are you leaning on most — cost, pace, economy, or range?",
    'Which of those matters most — what it costs, how quick it is, what it drinks, or how far it goes?',
  ],
  finance: [
    'Would you like a specialist to confirm the terms?',
    'Want someone to confirm the actual terms?',
    'Shall I get a specialist to firm those numbers up?',
  ],
} as const satisfies Record<string, readonly string[]>;

export type AskKind = keyof typeof ASKS;

/**
 * Said when no tool can answer the question.
 *
 * Listed, like the asks, because the next turn has to recognise it: the offer
 * that follows is what turns into a ticket, and "yes please" means nothing
 * without knowing what it answered.
 *
 * The WORDING matters more than it looks. "I don't have that confirmed" is
 * true and useless — it tells the customer about our database when they asked
 * about a car, and it reads as a shrug. These say the same thing from the
 * customer's side: the answer is worth getting right, and it is being got.
 * Nothing here promises a figure we do not have; it promises a person who
 * does, which is a promise this code then actually keeps by raising a ticket.
 */
export const CANNOT_HELP = [
  "I'd rather get you a proper answer on that than a half one.",
  'Let me get you the exact answer on that rather than my best guess.',
  "I want to get that one exactly right for you, so let me not guess at it.",
  "That's worth getting right rather than roughly right.",
  "I'd sooner check that than tell you something that turns out to be wrong.",
] as const;

export function askedFor(assistantText: string, kind: AskKind): boolean {
  return ASKS[kind].some((ask) => assistantText.includes(ask));
}

/** True when the assistant's last message admitted it could not answer. */
export function saidCannotHelp(assistantText: string): boolean {
  return CANNOT_HELP.some((line) => assistantText.includes(line));
}

/** True when the assistant's last message was waiting for an answer. */
function isAsk(assistantText: string): boolean {
  return (
    saidCannotHelp(assistantText) ||
    Object.values(ASKS).some((variants) => variants.some((ask) => assistantText.includes(ask)))
  );
}
