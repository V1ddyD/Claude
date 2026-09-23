import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { respondToMessage } from '../../src/server/ai/conversation';
import { ensureConversation } from '../../src/server/ai/extraction';
import { RuleBasedModel } from '../../src/server/ai/rule-based';
import { saidCannotHelp } from '../../src/server/ai/rule-based/state';
import { toPlainText } from '../../src/server/channels/plain-text';

/**
 * The questions a customer opens with, none of which name a car.
 *
 * "Which is cheapest", "what's popular", "is the top trim worth it", "what
 * should I buy" — an assistant that cannot take these is an assistant that
 * fails on the first message about half the time.
 *
 * What is asserted throughout is that the answer came from the database and
 * says what it measured. Never a particular sentence: the wording varies by
 * design, and a test that pins it down is a test that forbids the variation.
 */

let admin: Sql;

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

function chat() {
  const client = new RuleBasedModel();
  const session = ensureConversation(SINCLAIR_TENANT_ID, {});

  return async function say(message: string) {
    const { conversationId, visitorId } = await session;
    return respondToMessage({
      tenantId: SINCLAIR_TENANT_ID,
      conversationId,
      visitorId,
      userMessage: message,
      requestId: 'advice',
      client,
    });
  };
}

describe('ranking the range', () => {
  it('names the cheapest car, and it is the cheapest car', async () => {
    const reply = await chat()('which is the cheapest one?');
    expect(reply.toolsUsed).toContain('rankModels');

    // The floor of the range, taken from the buildable configurations rather
    // than from the headline MSRP — which is the figure the assistant quotes.
    const [row] = await admin<{ name: string }[]>`
      SELECT m.full_name AS name
        FROM model_configurations c
        JOIN vehicle_models m ON m.id = c.model_id
       WHERE m.tenant_id = ${SINCLAIR_TENANT_ID} AND m.status = 'published'
       ORDER BY c.price_cents ASC
       LIMIT 1
    `;
    expect(reply.text).toContain(row!.name);
  });

  it('names the most powerful car, and it is the most powerful car', async () => {
    const reply = await chat()('which is the fastest?');
    expect(reply.toolsUsed).toContain('rankModels');

    const [row] = await admin<{ name: string }[]>`
      SELECT m.full_name AS name
        FROM powertrains p
        JOIN vehicle_models m ON m.id = p.model_id
       WHERE m.tenant_id = ${SINCLAIR_TENANT_ID} AND m.status = 'published'
       ORDER BY p.horsepower DESC NULLS LAST
       LIMIT 1
    `;
    expect(reply.text).toContain(row!.name);
  });

  it('reads "cheapest to run" as a question about fuel, not about price', async () => {
    const reply = await chat()('which is cheapest to run?');
    expect(reply.toolsUsed).toContain('rankModels');

    const [row] = await admin<{ name: string }[]>`
      SELECT m.full_name AS name
        FROM powertrains p
        JOIN vehicle_models m ON m.id = p.model_id
       WHERE m.tenant_id = ${SINCLAIR_TENANT_ID} AND m.status = 'published'
         AND p.consumption_l100 IS NOT NULL
       ORDER BY p.consumption_l100 ASC
       LIMIT 1
    `;
    expect(reply.text).toContain(row!.name);
    expect(reply.text).toMatch(/L\/100km/);
  });

  it('answers "what is popular" from something real, and says what', async () => {
    const reply = await chat()('whats the most popular car right now?');
    expect(reply.toolsUsed).toContain('rankModels');

    // Either basis is acceptable — what is not acceptable is a bare verdict
    // with nothing behind it, so the measure has to be in the reply.
    expect(reply.text).toMatch(/asking about|keep most of on the ground/i);

    // The ORDER is a fact about the range. The COUNT is the dealership's
    // business and must never be quoted at a customer.
    expect(reply.text).not.toMatch(/\b\d+\s+(enquir|lead|sale|unit|in stock)/i);
  });

  it('never invents a popularity figure', async () => {
    const reply = await chat()('what sells the most?');
    // Percentages and "x out of y" are how a made-up popularity claim reads.
    expect(reply.text).not.toMatch(/\d+\s?%|\d+ out of \d+|best.?selling since/i);
  });
});

describe('which trim is worth it', () => {
  it('lays out the ladder with the step price and what it buys', async () => {
    const reply = await chat()('best value for money trim on the S5?');
    expect(reply.toolsUsed).toContain('rankTrims');

    const trims = await admin<{ name: string }[]>`
      SELECT t.name
        FROM trims t
        JOIN vehicle_models m ON m.id = t.model_id
       WHERE m.tenant_id = ${SINCLAIR_TENANT_ID} AND m.slug = 's5'
       ORDER BY t.tier_order
    `;
    for (const trim of trims) expect(reply.text).toContain(trim.name);

    // A price step, and the equipment it buys.
    expect(reply.text).toMatch(/more than the one below/);
    expect(reply.text).toMatch(/Adds /);
  });

  it('does not tell the cheapest trim that it adds something', async () => {
    // There is nothing below the bottom rung. "Adds" there reads as though the
    // entry car were an upgrade on something.
    const reply = await chat()('which S5 trim is best value?');
    const firstLine = reply.text.split('\n').find((line) => line.startsWith('- **'));
    expect(firstLine).toBeDefined();
    expect(firstLine).not.toMatch(/Adds /);
    expect(firstLine).toMatch(/Comes with /);
  });

  it('says its verdict is arithmetic rather than advice', async () => {
    const reply = await chat()('is the top trim on the S5 worth it?');
    expect(reply.text).toMatch(/on paper|arithmetic|what you get for the money/i);
  });

  it('asks which car when the question names none', async () => {
    const reply = await chat()('which trim is the best value for money?');
    expect(reply.toolsUsed).toEqual([]);
    expect(reply.text).toMatch(/which/i);
    // And offers the range to pick from rather than leaving them guessing.
    expect(reply.text).toContain('Sinclair S5');
  });
});

describe('asking for a recommendation', () => {
  it('asks one question back instead of reciting the catalogue', async () => {
    const reply = await chat()('what should i buy?');
    expect(reply.toolsUsed).toEqual([]);

    // The whole point: a short question, not ten models with prices attached.
    expect(reply.text).toMatch(/\?$/);
    expect(reply.text.length).toBeLessThan(220);
    expect(reply.text).not.toContain('Sinclair S5');
  });

  it('turns the answer to that question into a real ranking', async () => {
    const say = chat();
    await say('what do you recommend?');
    const reply = await say('running costs');

    expect(reply.toolsUsed).toContain('rankModels');
    expect(reply.text).toMatch(/L\/100km/);
  });
});

describe('questions the catalogue cannot answer', () => {
  it('leads with the car rather than with an apology', async () => {
    const reply = await chat()('how big is the boot on the X7?');

    expect(reply.toolsUsed).toContain('getVehicle');
    expect(reply.text).toContain('Sinclair X7');
    // Real information about the car appears before the caveat about the
    // figure we do not hold.
    expect(reply.text.indexOf('Sinclair X7')).toBeLessThan(
      reply.text.search(/rather|exact figure/i),
    );
  });

  it('never invents the measurement', async () => {
    const reply = await chat()('how big is the boot on the X7?');
    // A volume in litres or cubic feet. Fuel economy (L/100km) is a real
    // catalogue figure and is allowed; a boot volume is not.
    expect(reply.text).not.toMatch(/\b\d+\s?(litres|liters|cu ?ft|cubic|l(?!\/100))\b/i);
  });

  it('always offers a route to the answer', async () => {
    for (const question of [
      'what is the towing capacity of the T4?',
      'how heavy is the GT?',
      'what is the 0-60 on the R?',
    ]) {
      const reply = await chat()(question);
      // Recognised as the offer that a "yes" can accept, which is what makes
      // the next turn raise a ticket rather than start again.
      expect.soft(saidCannotHelp(reply.text), question).toBe(true);
      expect.soft(reply.text, question).toMatch(/put it to them|ask them|onto it|come back to you|pass it on|pass it along|hand it over/i);
    }
  });
});

describe('how much it says at once', () => {
  it('answers a stock question with stock, not with three tool results', async () => {
    // Trims and colours are looked up first so the query can filter on real
    // codes. Nobody asked for them, and printing all three results is what
    // turned a two-line answer into a wall of text.
    const reply = await chat()('any E5s in stock?');
    expect(reply.toolsUsed).toContain('getVehicleTrims');
    expect(reply.toolsUsed).toContain('checkInventory');

    // The paint palette and the trim ladder both have headings of their own.
    // Either one appearing here means a groundwork result was pasted in
    // alongside the answer, which is what made these replies unreadable.
    expect(reply.text).not.toMatch(/^Paint:/m);
    expect(reply.text).not.toMatch(/^Interior:/m);
    expect(reply.text).not.toMatch(/comes as standard|included\.$/im);

    // Every bullet is a car on the floor, and there are not many of them.
    const bullets = reply.text.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets.length).toBeLessThanOrEqual(4);
    for (const bullet of bullets) expect(bullet).toMatch(/stock [A-Z]/);
  });

  it('keeps a long list short and offers the rest', async () => {
    const reply = await chat()('what colours does the S5 come in?');

    const [counted] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM colours c
        JOIN vehicle_models m ON m.id = c.model_id
       WHERE m.tenant_id = ${SINCLAIR_TENANT_ID} AND m.slug = 's5'
    `;

    const shown = reply.text.split('\n').filter((line) => line.startsWith('- ')).length;
    expect(shown).toBeLessThanOrEqual(10);
    if ((counted?.count ?? 0) > shown) expect(reply.text).toMatch(/more|the lot|list them/i);
  });

  it('gives an overview as a card, not a spec sheet', async () => {
    const reply = await chat()('tell me about the S5');

    // One line per fact. The engines are named — a customer asked to be told
    // about the car — but the per-engine breakdown (torque, gearbox, economy
    // for each) is offered, not pasted.
    expect(reply.text).toMatch(/At a glance:/);
    expect(reply.text).toMatch(/Engines:/);
    expect(reply.text).not.toMatch(/\bNm\b/);
    const bullets = reply.text.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets.length).toBeLessThanOrEqual(9);
  });

  it('quotes one starting price, and it is one you can actually order', async () => {
    const say = chat();
    const overview = await say('tell me about the S5');
    const trims = await say('what trims are there?');

    const [row] = await admin<{ price: number }[]>`
      SELECT MIN(c.price_cents)::int AS price
        FROM model_configurations c
        JOIN vehicle_models m ON m.id = c.model_id
       WHERE m.tenant_id = ${SINCLAIR_TENANT_ID} AND m.slug = 's5'
    `;
    const formatted = `$${(row!.price / 100).toLocaleString('en-US')}`;

    // The overview used to quote the headline MSRP, which is sometimes a
    // combination nobody builds — so it named a lower figure than every trim
    // listed two messages later.
    expect(overview.text).toContain(formatted);
    expect(trims.text).toContain(formatted);
  });
});

describe('answering the message in front of it', () => {
  it('does not replay the last car it was told about', async () => {
    // The bug this exists for: `modelSlug` remembers every car named in the
    // conversation, so once somebody mentioned the S5, every message the
    // classifier could not parse replied with the S5 overview. Four different
    // questions in a row got the same paragraph, and so did "Dude".
    const say = chat();
    await say('tell me about the S5');

    const replies = [
      await say('Dude'),
      await say('lol'),
      await say('ok whatever'),
    ];

    for (const reply of replies) {
      expect.soft(reply.toolsUsed).toEqual([]);
      expect.soft(reply.text).not.toContain('Premium Mid-Size SUV');
    }
  });

  it('still answers a follow-up about the car under discussion', async () => {
    // The fix must not go too far the other way: "what colours does it come
    // in?" names no car and is obviously about the one being discussed.
    const say = chat();
    await say('tell me about the S5');
    const reply = await say('what colours does it come in?');

    expect(reply.toolsUsed).toContain('getVehicleColours');
  });

  it('gives a different answer to a different question', async () => {
    const say = chat();
    await say('tell me about the S5');

    const range = await say('What other car do you guys sell?');
    const sports = await say('So you guys have sports cars?');

    expect(range.text).toContain('Sinclair T4');
    expect(sports.toolsUsed).toContain('rankModels');
    expect(range.text).not.toBe(sports.text);
  });
});

describe('a shape we do not build', () => {
  it('says so, and says what we do build', async () => {
    const reply = await chat()('Any hatch backs?');

    expect(reply.toolsUsed).toEqual([]);
    expect(reply.text).toMatch(/hatchback/i);
    expect(reply.text).toMatch(/don't build|doesn't make|no hatchback/i);
    // The range underneath, so the answer and the next question arrive together.
    expect(reply.text).toContain('Sinclair S1');
  });

  it('gets the article right', async () => {
    const reply = await chat()('do you sell convertibles?');
    expect(reply.text).not.toMatch(/\ban convertible\b/i);
    expect(reply.text).toMatch(/a convertible/i);
  });

  it('does not claim we lack something we actually build', async () => {
    // "Estate" is a wagon and "saloon" is a sedan. Telling somebody we do not
    // build one while it sits on the forecourt would be worse than a shrug.
    for (const question of ['do you have any estates?', 'any saloons?']) {
      const reply = await chat()(question);
      expect.soft(reply.text, question).not.toMatch(/don't build|doesn't make/i);
    }
  });
});

describe('what goes out over Instagram', () => {
  it('carries no markdown a direct message cannot render', async () => {
    const say = chat();
    for (const question of [
      'tell me about the S5',
      'which is cheapest?',
      'best value trim on the S5?',
      'any E5s in stock?',
      'what cars do you make?',
    ]) {
      const reply = await say(question);
      const plain = toPlainText(reply.text);
      expect.soft(plain, question).not.toContain('**');
      expect.soft(plain, question).not.toMatch(/^- /m);
    }
  });

  it('uses no em dashes anywhere in its own copy', async () => {
    const say = chat();
    for (const question of [
      'hello',
      'tell me about the S5',
      'what trims are there?',
      'what colours?',
      'which is the fastest?',
      'best value trim on the S5?',
      'any E5s in stock?',
      'when are you open?',
      'where are you?',
      'what should i buy?',
      'how big is the boot on the X7?',
      'Dude',
    ]) {
      const reply = await say(question);
      expect.soft(reply.text, question).not.toContain('—');
    }
  });
});
