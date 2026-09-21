import { describe, it, expect } from 'vitest';
import { voiceFor, seedFrom } from '../../src/server/ai/rule-based/voice';
import { ASKS, CANNOT_HELP, askedFor, saidCannotHelp, remember } from '../../src/server/ai/rule-based/state';

/**
 * Saying the same thing more than one way.
 *
 * Variation is the cheap half. The expensive half is that the assistant reads
 * its OWN previous message to decide whether the customer just answered a
 * question — so a wording it can produce but not recognise is a question it
 * asks, gets answered, and asks again. That is the single most infuriating
 * thing a bot does, and the reason the banks and the recognisers live in one
 * file.
 */

describe('every wording of a question', () => {
  it('is recognised as that question', () => {
    for (const [kind, variants] of Object.entries(ASKS)) {
      for (const variant of variants) {
        expect
          .soft(askedFor(variant, kind as keyof typeof ASKS), `${kind}: "${variant}"`)
          .toBe(true);
      }
    }
  });

  it('is recognised when it is only part of a longer message', () => {
    // Which is how they are actually sent — after a list of times, or behind
    // an acknowledgement.
    for (const variant of ASKS.time) {
      expect.soft(askedFor(`1. Monday at 2:00 pm\n2. Tuesday at 10:00 am\n\n${variant}`, 'time')).toBe(true);
    }
    for (const variant of ASKS.consent) {
      expect.soft(askedFor(`Lovely, thank you, Alex. ${variant}`, 'consent')).toBe(true);
    }
  });

  it('does not answer to a different question', () => {
    // A phone question read as a consent question would record "07700 900000"
    // as permission to call.
    for (const variant of ASKS.phone) {
      expect.soft(askedFor(variant, 'consent'), variant).toBe(false);
    }
    for (const variant of ASKS.contact) {
      expect.soft(askedFor(variant, 'phone'), variant).toBe(false);
    }
  });
});

describe('every wording of "I cannot answer that"', () => {
  it('is recognised, so the offer that follows can be accepted', () => {
    // "Yes please" means nothing unless the previous turn is known to have
    // offered to pass the question to a person.
    for (const line of CANNOT_HELP) {
      expect.soft(saidCannotHelp(line), line).toBe(true);
    }
    expect(saidCannotHelp('Here are the trims.')).toBe(false);
  });
});

describe('which phrasing is used', () => {
  it('is the same every time for the same conversation', () => {
    // The whole assistant is testable only because of this. It also means a
    // customer scrolling back sees what they saw the first time.
    const options = ['one', 'two', 'three'] as const;
    for (const seed of [0, 1, 7, 1024, 999999]) {
      const first = voiceFor(seed).pick('k', options);
      expect(voiceFor(seed).pick('k', options)).toBe(first);
      expect(voiceFor(seed).pick('k', options)).toBe(first);
    }
  });

  it('actually varies across conversations', () => {
    // A bank nothing ever reaches the end of is a constant with extra steps.
    const options = ['a', 'b', 'c', 'd'] as const;
    const seen = new Set(
      Array.from({ length: 200 }, (_, i) => voiceFor(seedFrom('msg', i)).pick('k', options)),
    );
    expect(seen.size).toBe(options.length);
  });

  it('moves on as a conversation goes, so a repeated question is not repeated back', () => {
    const asked = new Set<string>();
    for (let turn = 1; turn <= 6; turn += 1) {
      const exchanges = Array.from({ length: turn }, () => ({
        said: 'what colours does it come in?',
        asked: '',
      }));
      const memory = remember(exchanges);
      asked.add(voiceFor(memory.seed).pick('ask:model', ASKS.model));
    }
    // Asked the identical question six times, it does not answer identically
    // six times.
    expect(asked.size).toBeGreaterThan(1);
  });

  it('keeps the decisions in one reply independent', () => {
    // Without a key every bank lands on the same index, and the whole message
    // moves in lockstep — which is its own pattern, just a subtler one.
    const four = ['w', 'x', 'y', 'z'] as const;
    const pairs = Array.from({ length: 60 }, (_, i) => {
      const v = voiceFor(seedFrom(i));
      return `${v.pick('lead', four)}${v.pick('close', four)}`;
    });
    // All sixteen combinations are reachable; a lockstepped picker reaches four.
    expect(new Set(pairs).size).toBeGreaterThan(four.length);
  });
});
