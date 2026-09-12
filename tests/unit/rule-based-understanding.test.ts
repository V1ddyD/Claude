import { describe, it, expect } from 'vitest';
import {
  understand, nameFromReply, findConfirmationCode, findOrdinal,
  findTradeInVehicle, saidMatchesSlot, chosenFromOffer,
} from '../../src/server/ai/rule-based/understand';
import { readConversation, remember, ASKS } from '../../src/server/ai/rule-based/state';
import { decide } from '../../src/server/ai/rule-based/script';

/**
 * The rule-based assistant's reading of a customer.
 *
 * Everything here runs without a database or a model, which is what makes the
 * failure modes worth pinning down: a classifier that quietly misses a plural,
 * or a consent check that accepts an email address as agreement, would both
 * look fine in a demo.
 */

describe('classifying what was asked', () => {
  const cases: [string, string][] = [
    ['What engines does the S5 have?', 'powertrains'],
    ['what colours can I get the E5 in', 'colours'],
    ['Which trims are there?', 'trims'],
    ['What options come with it?', 'options'],
    ['What is standard on the Premium?', 'features'],
    ['How much is the S5 Premium?', 'price'],
    ['Do you have any in stock?', 'stock'],
    ['S5 or X7, which is better?', 'compare'],
    ['What would that cost me a month?', 'finance'],
    ['Can I book a test drive on Saturday?', 'test_drive'],
    ['I need to cancel my booking', 'cancel'],
    ['I want to trade in my old car', 'trade_in'],
    ['Can I speak to a salesperson?', 'human'],
    ['Please call me back', 'callback'],
    ['What time are you open?', 'hours'],
    ['Where are you located?', 'location'],
    ['Hello there', 'greeting'],
    ['Tell me about the S3', 'vehicle_overview'],
  ];

  it.each(cases)('%s -> %s', (text, intent) => {
    expect(understand(text).intent).toBe(intent);
  });

  it('does not treat naming a car as a question it can answer', () => {
    // Honest ignorance beats an overview that answers something else.
    expect(understand('Does the S5 tow a three horse trailer in winter?').intent).toBe('unknown');
  });

  it('does not read a phone number as a budget', () => {
    const parsed = understand('Alex Mercer, alex@example.com, 416 555 0134');
    expect(parsed.phone).toBe('416 555 0134');
    expect(parsed.email).toBe('alex@example.com');
    expect(parsed.budgetCents).toBeUndefined();
  });

  it('reads a budget however it is written', () => {
    expect(understand('around $55,000').budgetCents).toBe(5_500_000);
    expect(understand('under 60k').budgetCents).toBe(6_000_000);
    expect(understand('about 48000').budgetCents).toBe(4_800_000);
    // A distance is not a price.
    expect(understand('it has done 90000 km').budgetCents).toBeUndefined();
  });

  it('takes a name only from an introduction', () => {
    expect(understand("I'm Alex Mercer").name).toBe('Alex Mercer');
    expect(understand('Looking at the Sport Plus in Carmine Red').name).toBeUndefined();
  });

  it('takes a name loosely only once one has been asked for', () => {
    expect(nameFromReply('Alex Mercer, alex@example.com')).toBe('Alex Mercer');
    expect(nameFromReply('yes please')).toBeUndefined();
  });
});

describe('reading details back', () => {
  it('recognises a confirmation code by its alphabet', () => {
    expect(findConfirmationCode('my code is BCDF23')).toBe('BCDF23');
    // Vowels and lookalikes are not in the alphabet codes are drawn from.
    expect(findConfirmationCode('my code is AEIOU1')).toBeUndefined();
  });

  it('reads a place in a list without reading a model name as one', () => {
    expect(findOrdinal('the second one please')).toBe(1);
    expect(findOrdinal('number 3')).toBe(2);
    expect(findOrdinal('the S5 please')).toBeUndefined();
  });

  it('reads a trade-in vehicle, converting miles because the field is km', () => {
    const vehicle = findTradeInVehicle('2019 Toyota Camry with 80,000 km, good condition');
    expect(vehicle).toMatchObject({
      year: 2019, make: 'Toyota', model: 'Camry', mileageKm: 80_000, condition: 'good',
    });
    expect(findTradeInVehicle('a 2015 Honda Civic, 50000 miles').mileageKm).toBe(80_467);
  });
});

describe('choosing a time', () => {
  const offered =
    '1. Saturday, September 12, 2026 at 10:00 a.m. EDT\n' +
    '2. Saturday, September 12, 2026 at 2:00 p.m. EDT\n' +
    '3. Monday, September 14, 2026 at 9:00 a.m. EDT\n\n' +
    ASKS.time;

  it('resolves a place in the list against the list as it was shown', () => {
    expect(chosenFromOffer(offered, 'the second one')).toContain('2:00');
  });

  it('resolves a day and time', () => {
    expect(chosenFromOffer(offered, 'Monday at 9am works')).toContain('Monday');
  });

  it('refuses to choose when a day alone leaves two possibilities', () => {
    // Narrowing is not choosing. Booking one of them would invent a decision.
    expect(chosenFromOffer(offered, 'Saturday is good')).toBeUndefined();
  });

  it('matches the wording that was offered, not a re-derived time', () => {
    const label = 'Saturday, September 12, 2026 at 10:00 a.m. EDT';
    expect(saidMatchesSlot(label, 'saturday 10am')).toBe(true);
    // A time nobody offered is not a choice.
    expect(saidMatchesSlot(label, 'saturday at 3pm')).toBe(false);
    expect(saidMatchesSlot(label, 'monday at 10am')).toBe(false);
  });
});

describe('what it will act on', () => {
  const SYSTEM =
    'You are a product specialist for Sinclair Motors, a premium automotive manufacturer ' +
    'and dealership.\n\nToday is Friday (America/Toronto).\n\n## The range\n' +
    '- Sinclair S5 (s5) — mid-size SUV, from $52,900.00\n';

  const turn = (...messages: { role: 'user' | 'assistant'; content: string }[]) =>
    decide(SYSTEM, readConversation(messages), new Date('2026-09-11T12:00:00Z'));

  it('never writes before consent, however much else it knows', () => {
    const decision = turn(
      { role: 'user', content: 'Please call me back' },
      { role: 'assistant', content: ASKS.contact },
      { role: 'user', content: 'Alex Mercer, alex@example.com, 416 555 0134' },
    );
    expect(decision.tools).toEqual([]);
    expect(decision.text).toContain(ASKS.consent);
  });

  it('treats consent as a yes to being asked, never as a side effect of an email', () => {
    const withoutAsk = remember([
      { asked: '', said: 'my email is alex@example.com' },
    ]);
    expect(withoutAsk.consent).toBe(false);

    const withAsk = remember([
      { asked: ASKS.consent, said: 'yes, that is fine' },
    ]);
    expect(withAsk.consent).toBe(true);
  });

  it('asks which car before answering a question that needs one', () => {
    const decision = turn({ role: 'user', content: 'What colours are there?' });
    expect(decision.tools).toEqual([]);
    expect(decision.text).toContain(ASKS.model);
    // Offers only what this dealership's prompt said it sells.
    expect(decision.text).toContain('Sinclair S5');
  });

  it('carries a flow across a bare answer', () => {
    const decision = turn(
      { role: 'user', content: 'I want to trade in my old car' },
      { role: 'assistant', content: ASKS.vehicle },
      { role: 'user', content: '2019 Toyota Camry, 80,000 km' },
    );
    expect(decision.text).toContain(ASKS.condition);
  });
});
