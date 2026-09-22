/**
 * Saying the same thing more than one way.
 *
 * The assistant's facts come from tools and never vary. Its WORDING did not
 * vary either, and that is the tell: a person asked twice about two cars gets
 * two sentences built to the same template, word for word, and knows within
 * about four seconds that nobody is there.
 *
 * So phrasing is chosen from a bank instead of being fixed. Two rules make
 * that safe:
 *
 *   deterministic   the choice is a hash of the conversation, not a random
 *                   number. The same conversation always reads the same way,
 *                   which is what makes the assistant testable at all — and
 *                   it means a customer re-reading the thread sees what they
 *                   saw before.
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
}

export function voiceFor(seed: number): Voice {
  return {
    pick: (key, options) => options[seedFrom(seed, key) % options.length]!,
  };
}

/* -------------------------------------------------------------------------- */
/* Banks                                                                      */
/*                                                                            */
/* Every entry in a bank is interchangeable with every other. Where a fact     */
/* belongs in a sentence it is passed in — nothing here knows a price.         */
/* -------------------------------------------------------------------------- */

/** After answering, when there is an obvious next move but no need to push. */
export const ANYTHING_ELSE = [
  'Anything else you want to know?',
  'Anything else I can dig out?',
  'Want me to look at anything else?',
  "Shall I check anything else while I'm here?",
  'Anything else on your mind?',
  'What else can I get you?',
  'Anything else I can help with?',
] as const;

/** Acknowledging a request before doing it. */
export const ON_IT = [
  'Of course.',
  'Happy to.',
  'Sure.',
  'No problem.',
  'Right then.',
  'Absolutely.',
  'Yes, easily done.',
  'Leave that with me.',
  "Not a problem at all.",
] as const;

/** Thanking someone for an answer we asked for. */
export const GOT_IT = [
  'Got it.',
  'Lovely, thank you.',
  'Thanks.',
  'Perfect.',
  "That's great, thank you.",
  'Brilliant, thank you.',
  'Thank you.',
  'Right, got that.',
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

/** Nudging towards a test drive without being pushy about it. */
export const OFFER_DRIVE = [
  'Say the word if you want to drive one.',
  'Happy to get you behind the wheel if you fancy it.',
  "I can check the diary if you'd like a drive.",
  'Let me know if you want to come and try one.',
  "There's no substitute for sitting in one, if you fancy a drive.",
  'I can get you booked in for a drive whenever suits.',
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
  return voice.pick(`${key}:whether`, [true, false, false]) ? voice.pick(key, options) : '';
}

/** Joins sentence fragments into one line, dropping the empty ones. */
export function sentences(...parts: (string | undefined | false)[]): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(' ');
}
