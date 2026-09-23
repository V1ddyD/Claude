/**
 * Saying the same thing more than one way.
 *
 * The assistant's facts come from tools and never vary. Its WORDING did not
 * vary either, and that is the tell: a person asked twice about two cars gets
 * two sentences built to the same template, word for word, and knows within
 * about four seconds that nobody is there.
 *
 * So phrasing is chosen from a bank instead of being fixed. Three rules make
 * that safe:
 *
 *   deterministic   the choice is a hash of the conversation, not a random
 *                   number. The same conversation always reads the same way,
 *                   which is what makes the assistant testable at all — and
 *                   it means a customer re-reading the thread sees what they
 *                   saw before.
 *
 *   fresh           a phrasing that appeared in the assistant's previous
 *                   message is skipped, so two replies in a row never open
 *                   with the same "Absolutely." or close with the same offer.
 *                   Without this, a hash that happens to land on the same
 *                   index twice is a bot saying the same sentence twice.
 *
 *   interchangeable every variant in a bank must mean exactly the same thing.
 *                   These are ways of saying something, never different
 *                   things to say. Nothing here decides anything.
 *
 * Variation is not the same as personality, and it is certainly not the same
 * as a model. This makes the assistant sound less like a form letter. It does
 * not make it understand anything it did not understand before.
 */

/** FNV-1a. Small, stable, and no dependency. */
export function seedFrom(...parts: (string | number | undefined)[]): number {
  let hash = 2166136261;
  for (const part of parts) {
    const text = String(part ?? '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return Math.abs(hash);
}

export interface Voice {
  /**
   * One phrasing from a bank.
   *
   * `key` keeps different decisions in the same reply independent: without it
   * every bank lands on the same index and the whole message moves in lockstep,
   * which is its own kind of pattern.
   */
  pick: <T>(key: string, options: readonly T[]) => T;
  /** Like pick, but only sometimes: the chance is one in `every`. */
  sometimes: (key: string, every: number) => boolean;
}

/**
 * A voice for one reply.
 *
 * `avoid` is the assistant's previous message. Any string option that appears
 * in it is passed over in favour of the next one in the bank, so consecutive
 * replies do not reuse a phrasing — unless every option has been used, in
 * which case the hash's choice stands rather than producing nothing.
 */
export function voiceFor(seed: number, avoid = ''): Voice {
  return {
    pick: (key, options) => {
      const start = seedFrom(seed, key) % options.length;
      for (let offset = 0; offset < options.length; offset += 1) {
        const option = options[(start + offset) % options.length]!;
        if (typeof option !== 'string' || !avoid || !avoid.includes(option)) return option;
      }
      return options[start]!;
    },
    sometimes: (key, every) => seedFrom(seed, key, 'sometimes') % every === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Banks                                                                      */
/*                                                                            */
/* Every entry in a bank is interchangeable with every other. Where a fact     */
/* belongs in a sentence it is passed in — nothing here knows a price.         */
/* -------------------------------------------------------------------------- */

/**
 * Before a good answer. The warmth a person puts in front of the information.
 *
 * Only in front of answers that are good news — a list of trims, a price, a
 * car in stock. Nobody says "Absolutely!" before "we don't have one".
 */
export const OPENERS = [
  'Absolutely.',
  'Sure thing.',
  'Very well.',
  'Certainly.',
  'Of course.',
  'Happy to help.',
  'With pleasure.',
  'Good question.',
  'Great question.',
  'Gladly.',
  "Let's have a look.",
] as const;

/** After answering, when there is an obvious next move but no need to push. */
export const ANYTHING_ELSE = [
  'Anything else you want to know?',
  'Anything else I can dig out for you?',
  'Want me to look at anything else?',
  "Shall I check anything else while I'm here?",
  'Anything else on your mind?',
  'What else can I help with?',
  'Is there anything else I can help you with?',
] as const;

/** Acknowledging a request before doing it. */
export const ON_IT = [
  'Of course.',
  'Happy to.',
  'Sure thing.',
  'Absolutely.',
  'Very well.',
  'Leave that with me.',
  'Not a problem at all.',
  'Certainly.',
] as const;

/** Thanking someone for an answer we asked for. */
export const GOT_IT = [
  'Got it.',
  'Lovely, thank you.',
  'Perfect.',
  "That's great, thank you.",
  'Brilliant, thank you.',
  'Wonderful.',
  'Thank you.',
] as const;

/** Offering the team when we genuinely cannot answer. */
export const OFFER_TEAM = [
  'the team can answer that one',
  'somebody here can answer that properly',
  'the team will know',
  'one of the team can sort that out',
  'the people here will have it to hand',
  'someone on the floor can tell you exactly',
  'the team have that in front of them',
] as const;

/**
 * Offers of a test drive.
 *
 * Also a recognition bank: a "yes" straight after one of these is a request
 * for the diary, and is treated as one. A drive offer written anywhere else in
 * the code, in words not listed here, is an offer that cannot be accepted.
 */
export const OFFER_DRIVE = [
  'Say the word if you want to drive one.',
  'Happy to get you behind the wheel if you fancy it.',
  "I can check the diary if you'd like a drive.",
  'Let me know if you want to come and try one.',
  "There's no substitute for sitting in one, if you fancy a drive.",
  'I can get you booked in for a drive whenever suits.',
  "Say the word if you'd like to drive one and I'll check the diary.",
  'Happy to get you behind the wheel of one, just say the word.',
  'I can book you in to see one whenever suits.',
  'Would you like to book a test drive?',
] as const;

/**
 * The fixed tail of an offer to show the rest of a list.
 *
 * The number in front of it varies ("There are 3 more"), so it is the tail that
 * the next turn looks for when deciding whether a "yes" means "show me all".
 */
export const MORE_TAILS = [
  'Want the lot?',
  "Say the word and I'll list them.",
  'Want to see them all?',
  'Shall I show you the rest?',
] as const;

/**
 * An offer to bring in a person. Accepted, it starts a handoff — which asks
 * for contact details and then passes the conversation to the team.
 */
export const OFFER_HUMAN = [
  'Would you like me to get someone from the team to help?',
  'Shall I bring in one of the team?',
  'Want me to pass you over to one of our specialists?',
] as const;

/**
 * A closing nudge, used sparingly.
 *
 * Every reply ending in a question is its own tell — real people sometimes
 * just answer. This is offered to callers to use on some turns, not all.
 */
export function maybeNudge(voice: Voice, key: string, options: readonly string[]): string {
  // Roughly one turn in three. Enough to feel attentive, rare enough not to
  // feel like being handled.
  return voice.sometimes(`${key}:whether`, 3) ? voice.pick(key, options) : '';
}

/** Joins sentence fragments into one line, dropping the empty ones. */
export function sentences(...parts: (string | undefined | false | null)[]): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(' ');
}

/** Joins paragraphs with a blank line between them, dropping the empty ones. */
export function paragraphs(...parts: (string | undefined | false | null)[]): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join('\n\n');
}
