import type Anthropic from '@anthropic-ai/sdk';
import {
  understand, nameFromReply, findConfirmationCode, findTradeInVehicle, chosenFromOffer,
  type Intent, type TradeInVehicle,
} from './understand';

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
  modelSlug?: string;
  comparisonSlugs: string[];
  trimCode?: string;
  powertrainHint?: string;
  colourCode?: string;
  budgetCents?: number;
  bodyStyle?: ReturnType<typeof understand>['bodyStyle'];
  electric?: boolean;
  awd?: boolean;
  name?: string;
  email?: string;
  phone?: string;
  /** Explicit. Never inferred from the customer having given an email address. */
  consent: boolean;
  termMonths?: number;
  confirmationCode?: string;
  /** The exact time the customer picked, as it was worded when offered. */
  chosenSlotLabel?: string;
  tradeIn: TradeInVehicle;
  /** The last thing asked that no tool could answer, kept for the ticket body. */
  openQuestion?: string;
}

/** Intents that span several turns, so a bare "yes" still belongs to one. */
const FLOWS: Intent[] = ['test_drive', 'cancel', 'callback', 'trade_in', 'human', 'finance'];

export function remember(exchanges: Exchange[]): Memory {
  const latest = understand(exchanges.at(-1)?.said ?? '');
  const asked = exchanges.at(-1)?.asked ?? '';

  const memory: Memory = {
    intent: latest.intent,
    latest,
    said: exchanges.map((e) => e.said),
    asked,
    comparisonSlugs: [],
    consent: false,
    tradeIn: {},
  };

  const flows: Flow[] = [];

  for (const exchange of exchanges) {
    const turn = understand(exchange.said);
    if (FLOWS.includes(turn.intent)) flows.push(turn.intent);

    // Accepting the offer to pass a question on is what starts a ticket.
    if (exchange.asked.includes(CANNOT_HELP) && turn.affirmative) flows.push('ticket');

    // A reply to one of our own questions is an answer, not a new question. A
    // contact detail recorded as "the thing we could not answer" would put
    // someone's name in front of staff as their enquiry.
    if (
      turn.intent === 'unknown' &&
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
    if (turn.trimHint) memory.trimCode = turn.trimHint;
    if (turn.powertrainHint) memory.powertrainHint = turn.powertrainHint;
    if (turn.colourHint) memory.colourCode = turn.colourHint;
    if (turn.budgetCents) memory.budgetCents = turn.budgetCents;
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
export const ASKS = {
  contact: 'Could I take your name and email address?',
  consent: 'Are you happy for the team to contact you about this?',
  phone: 'What number should the team call you on?',
  time: 'Which of those times suits you?',
  model: 'Which model did you have in mind?',
  code: 'What is the confirmation code on your booking, and the email address it was made with?',
  vehicle: 'What is the year, make, model and rough mileage of your current car?',
  condition: 'How would you describe its condition — excellent, good, fair or poor?',
  finance: 'Would you like a specialist to confirm the terms?',
} as const;

export type AskKind = keyof typeof ASKS;

/**
 * Said when no tool can answer the question.
 *
 * A constant because the next turn has to recognise it: an honest "I do not
 * have that" is only useful if the offer that follows it can be accepted.
 */
export const CANNOT_HELP =
  'I do not have that confirmed, and I will not guess at it.';

export function askedFor(assistantText: string, kind: AskKind): boolean {
  return assistantText.includes(ASKS[kind]);
}

/** True when the assistant's last message was waiting for an answer. */
function isAsk(assistantText: string): boolean {
  return (
    assistantText.includes(CANNOT_HELP) ||
    Object.values(ASKS).some((ask) => assistantText.includes(ask))
  );
}
