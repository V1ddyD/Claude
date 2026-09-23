import { describe, it, expect } from 'vitest';
import {
  understand, nameFromReply, findConfirmationCode, findOrdinal,
  findTradeInVehicle, saidMatchesSlot, chosenFromOffer, colourWords,
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

/**
 * The vocabulary a tenant's catalogue would supply.
 *
 * Passed in rather than known: nothing in the classifier contains a Sinclair
 * model name, which is what lets a different dealership's range work.
 */
const RANGE = {
  models: [
    { slug: 's3', name: 'Sinclair S3' },
    { slug: 's5', name: 'Sinclair S5' },
    { slug: 'x7', name: 'Sinclair X7' },
    { slug: 'e5', name: 'Sinclair E5' },
  ],
};

describe('classifying what was asked', () => {
  const cases: [string, string][] = [
    ['What engines does the S5 have?', 'powertrains'],
    ['what colours can I get the E5 in', 'colours'],
    ['Which trims are there?', 'trims'],
    ['What options come with it?', 'options'],
    ['What is standard on the Premium?', 'features'],
    ['Do you have any S5s in stock?', 'stock'],
    ['What is the best price you can do today?', 'human'],
    ['What is my 2019 BMW 3 Series worth?', 'trade_in'],
    ['Can I get the S5 in lime green?', 'colours'],
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
    expect(understand(text, RANGE).intent).toBe(intent);
  });

  it('recognises a model by slug, by name and in the plural', () => {
    expect(understand('tell me about the s5', RANGE).modelSlugs).toEqual(['s5']);
    expect(understand('tell me about the Sinclair S5', RANGE).modelSlugs).toEqual(['s5']);
    expect(understand('do you have any S5s?', RANGE).modelSlugs).toEqual(['s5']);
    // And knows nothing without a catalogue to know it from.
    expect(understand('tell me about the s5').modelSlugs).toEqual([]);
  });

  it('reads a measurement question as one, rather than as an overview', () => {
    // A tow rating is not in the catalogue and never will be invented. But the
    // question is still ABOUT the S5, and classifying it as such is what lets
    // the reply lead with what we do know and route the figure to a person.
    // Falling through to 'unknown' produced a shrug, which loses the customer.
    const parsed = understand('Does the S5 tow a three horse trailer in winter?', RANGE);
    expect(parsed.intent).toBe('specs');
    expect(parsed.modelSlugs).toEqual(['s5']);
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

  it('picks out colour words for the catalogue to resolve', () => {
    // Which of these the dealership actually sells is not decided here.
    expect(colourWords('in lime green')).toEqual(['green', 'lime']);
    expect(colourWords('in Obsidian Black')).toEqual(['black']);
    expect(colourWords('with the technology package')).toEqual([]);
  });

  it('reads a model name that carries digits or two words', () => {
    expect(findTradeInVehicle('my 2019 BMW 3 Series').model).toBe('3 Series');
    expect(findTradeInVehicle('a 2021 Tesla Model 3, 40,000 km').model).toBe('Model 3');
    expect(findTradeInVehicle('2018 Mercedes C-Class and 90,000 km').model).toBe('C-Class');
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

  it('matches the labels offered now, as well as older ones', () => {
    const label = 'Saturday, 26 September 2026 at 10am';
    expect(saidMatchesSlot(label, 'saturday 10am')).toBe(true);
    expect(saidMatchesSlot(label, '10:00am please')).toBe(true);
    expect(saidMatchesSlot(label, 'saturday at 3pm')).toBe(false);
    expect(saidMatchesSlot('Friday, 25 September 2026 at 2:30pm', 'friday 2:30pm')).toBe(true);
    expect(saidMatchesSlot('Friday, 25 September 2026 at 2:30pm', 'friday 2pm')).toBe(false);
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
      { role: 'assistant', content: ASKS.contact[0] },
      { role: 'user', content: 'Alex Mercer, alex@example.com, 416 555 0134' },
    );
    expect(decision.tools).toEqual([]);
    expect(decision.text).toContain(ASKS.consent[0]);
  });

  it('treats consent as a yes to being asked, never as a side effect of an email', () => {
    const withoutAsk = remember([
      { asked: '', said: 'my email is alex@example.com' },
    ]);
    expect(withoutAsk.consent).toBe(false);

    const withAsk = remember([
      { asked: ASKS.consent[0], said: 'yes, that is fine' },
    ]);
    expect(withAsk.consent).toBe(true);
  });

  it('asks which car before answering a question that needs one', () => {
    const decision = turn({ role: 'user', content: 'What colours are there?' });
    expect(decision.tools).toEqual([]);
    expect(ASKS.model.some((ask) => decision.text.includes(ask))).toBe(true);
    // Offers only what this dealership's prompt said it sells.
    expect(decision.text).toContain('Sinclair S5');
  });

  it('says outright that we do not make a car we do not make', () => {
    const decision = turn({ role: 'user', content: 'Tell me about the Sinclair Z9' });
    expect(decision.tools).toEqual([]);
    // One of several wordings, all saying the same thing.
    expect(decision.text).toContain('Z9');
    expect(decision.text).toMatch(/don't make|don't build|no Z9/i);
    // And names what does exist, which is the useful half of the answer.
    expect(decision.text).toContain('Sinclair S5');
  });

  it('reads the letter, not the spelling, for the article', () => {
    expect(turn({ role: 'user', content: 'Do you sell the X9?' }).text).toContain('an X9');
    expect(turn({ role: 'user', content: 'Do you sell the Z9?' }).text).toContain('a Z9');
  });

  it('does not deny making a car when the token is a deadline', () => {
    // "by Q3" is when they want it. Denying we build a Q3 would be absurd.
    const deadline = turn({ role: 'user', content: 'Can I get a car by Q3 next year?' });
    expect(deadline.text).not.toMatch(/don't (make|build)|no Q4/i);

    // Whereas a rival's model, named on its own, is exactly what to deny.
    expect(turn({ role: 'user', content: 'Do you sell the Q4?' }).text).toMatch(
      /don't (make|build)|no Q4/i,
    );
  });

  it('leaves a real model alone when another token sits beside it', () => {
    const decision = turn({ role: 'user', content: 'Do you have the S5 in stock by Q3?' });
    // Trims and colours are resolved first so the stock query can filter on
    // real codes; what matters here is that it did not deny making a Q3.
    expect(decision.tools.map((tool) => tool.name)).toContain('getVehicleTrims');
    expect(decision.text).toBe('');
  });

  it('quotes no price the digest happened to carry', () => {
    // The digest routes a question; it does not answer one. A figure in a
    // reply has to have come from a tool in this conversation.
    const decision = turn({ role: 'user', content: 'What colours are there?' });
    expect(decision.text).toContain('Sinclair S5');
    expect(decision.text).not.toMatch(/\$/);
  });

  it('asks only for the trade-in details it does not already have', () => {
    const decision = turn({ role: 'user', content: 'What is my 2019 BMW 3 Series worth?' });
    expect(decision.text).toContain('rough mileage');
    expect(decision.text).toContain('2019 BMW 3 Series');
    // Not the year and make it was just told.
    expect(decision.text).not.toContain('year, make, model');
  });

  it('keeps the appraisal flow alive across the answer to a tailored question', () => {
    const decision = turn(
      { role: 'user', content: 'What is my 2019 BMW 3 Series worth?' },
      { role: 'assistant', content: `${ASKS.appraisal} What is the rough mileage of the 2019 BMW 3 Series?` },
      { role: 'user', content: 'About 95,000 km' },
    );
    expect(ASKS.condition.some((ask) => decision.text.includes(ask))).toBe(true);
  });

  it('carries a flow across a bare answer', () => {
    const decision = turn(
      { role: 'user', content: 'I want to trade in my old car' },
      { role: 'assistant', content: ASKS.vehicle[0] },
      { role: 'user', content: '2019 Toyota Camry, 80,000 km' },
    );
    expect(ASKS.condition.some((ask) => decision.text.includes(ask))).toBe(true);
  });
});
