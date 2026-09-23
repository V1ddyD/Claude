import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { respondToMessage } from '../../src/server/ai/conversation';
import { ensureConversation, extractAndScore } from '../../src/server/ai/extraction';
import { RuleBasedModel } from '../../src/server/ai/rule-based';
import { leads, leadSignals } from '../../src/server/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * What the conversation leaves behind.
 *
 * The scripted assistant extracts EVIDENCE, and the existing rule engine turns
 * evidence into a priority — the split the specification insists on (§11, §16,
 * §56). So these tests assert two separate things: that the right evidence was
 * recorded, and that the band the rules produced from it is the one a
 * salesperson would expect. Neither is the assistant's opinion.
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

  return {
    session,
    async say(message: string) {
      const { conversationId, visitorId } = await session;
      return respondToMessage({
        tenantId: SINCLAIR_TENANT_ID,
        conversationId,
        visitorId,
        userMessage: message,
        requestId: 'leads',
        client,
      });
    },
  };
}

async function scoreOf(conversationId: string) {
  return extractAndScore({ tenantId: SINCLAIR_TENANT_ID, conversationId });
}

async function signalsOf(conversationId: string) {
  return withTenant(SINCLAIR_TENANT_ID, async (db) => {
    const [lead] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.tenantId, db.tenantId), eq(leads.conversationId, conversationId)))
      .limit(1);
    if (!lead) return {} as Record<string, unknown>;

    const rows = await db
      .select({ field: leadSignals.field, value: leadSignals.value })
      .from(leadSignals)
      .where(and(eq(leadSignals.tenantId, db.tenantId), eq(leadSignals.leadId, lead.id)));

    return Object.fromEntries(rows.map((row) => [row.field, row.value]));
  });
}

describe('a specific buyer with a date', () => {
  it('becomes a high priority lead, by the existing rules', async () => {
    const conversation = chat();
    const { conversationId } = await conversation.session;

    // One message carrying a model, a trim, an engine, a budget and a
    // timeframe — the §3 case. None of it is asked for twice afterwards.
    await conversation.say(
      'I want the S5 Premium with the 2.0 Turbo. I have $55,000 ready and I am buying this week.',
    );
    await conversation.say('Can I test drive it?');
    await conversation.say('The first one please');
    await conversation.say('Alex Keeler, alex.keeler@example.test, 416 555 0101');
    const booked = await conversation.say('Yes, that is fine');
    expect(booked.toolsUsed).toContain('createTestDrive');

    const result = await scoreOf(conversationId);
    const recorded = await signalsOf(conversationId);

    // The evidence the assistant extracted.
    expect(recorded.modelSlug).toBe('s5');
    expect(recorded.trimCode).toBe('PREMIUM');
    expect(recorded.powertrainCode).toBe('2.0T-AWD');
    expect(recorded.budgetCents).toBe(5_500_000);
    expect(recorded.purchaseTimeframe).toBe('immediately');
    expect(recorded.testDriveRequested).toBe(true);

    // The band the rules produced from it.
    expect(result.priority).toBe('high');
    expect(result.rationale).toBeTruthy();
  });
});

describe('a configuration stated but never priced', () => {
  it('is still recorded, because the catalogue confirms it', async () => {
    const conversation = chat();
    const { conversationId } = await conversation.session;

    // Books a test drive and never asks a price, so no tool validated the
    // trim. Extraction offers the words to the catalogue itself.
    await conversation.say('I want the S5 Premium with the 2.0 Turbo. Can I drive it Saturday?');
    await conversation.say('The first one please');
    await conversation.say('Tess Varga, tess.varga@example.test, 416 555 0102');
    await conversation.say('Yes, that is fine');

    await scoreOf(conversationId);
    const recorded = await signalsOf(conversationId);

    expect(recorded.trimCode).toBe('PREMIUM');
    expect(recorded.powertrainCode).toBe('2.0T-AWD');
  });

  it('records nothing for a trim this dealership does not have', async () => {
    const conversation = chat();
    const { conversationId } = await conversation.session;

    // "Navigator" is the other tenant's trim name. It must resolve to nothing.
    await conversation.say('I want the S5 Navigator. Please call me.');
    await conversation.say('Ola Bergqvist, ola.bergqvist@example.test, 416 555 0188');
    await conversation.say('Yes, that is fine');

    await scoreOf(conversationId);
    const recorded = await signalsOf(conversationId);

    expect(recorded.modelSlug).toBe('s5');
    expect(recorded.trimCode).toBeUndefined();
  });
});

describe('a buyer a couple of months out', () => {
  it('becomes a medium priority lead', async () => {
    const conversation = chat();
    const { conversationId } = await conversation.session;

    await conversation.say(
      'I am interested in the X7 and have about $80,000 to spend, buying in two months.',
    );
    await conversation.say('Does it tow a three horse trailer in winter?');
    await conversation.say('Yes please');
    await conversation.say('Robin Vance, robin.vance@example.test');
    const ticketed = await conversation.say('Yes');
    expect(ticketed.toolsUsed).toContain('createSupportTicket');

    const result = await scoreOf(conversationId);
    const recorded = await signalsOf(conversationId);

    expect(recorded.purchaseTimeframe).toBe('one_to_three_months');
    expect(recorded.budgetCents).toBe(8_000_000);
    expect(result.priority).toBe('medium');
  });
});

describe('someone just looking', () => {
  it('becomes a low priority lead rather than a hot one', async () => {
    const conversation = chat();
    const { conversationId } = await conversation.session;

    await conversation.say('Just looking for now, probably next year. What is the S1 like?');
    await conversation.say('Does it come with a roof box from the factory?');
    await conversation.say('Yes please');
    await conversation.say('Jamie Ollo, jamie.ollo@example.test');
    await conversation.say('Yes');

    const result = await scoreOf(conversationId);
    const recorded = await signalsOf(conversationId);

    expect(recorded.justBrowsing).toBe(true);
    expect(recorded.purchaseTimeframe).toBe('over_six_months');
    // Enthusiasm is not intent. A browser must not outrank a buyer.
    expect(result.priority).toBe('low');
  });
});

describe('information given gradually', () => {
  it('updates one lead rather than creating several', async () => {
    const conversation = chat();
    const { conversationId } = await conversation.session;

    await conversation.say('Hello');
    await conversation.say('I am looking at the E5');
    await conversation.say('My budget is about 70k');
    await conversation.say('I would like to speak to someone');
    await conversation.say('Dev Achara, dev.achara@example.test');
    await conversation.say('Yes, that is fine');
    await conversation.say('I am hoping to buy within a month');

    await scoreOf(conversationId);

    const rows = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      db
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.tenantId, db.tenantId), eq(leads.conversationId, conversationId))),
    );
    expect(rows).toHaveLength(1);

    const recorded = await signalsOf(conversationId);
    // Everything said across seven messages, on one record.
    expect(recorded.modelSlug).toBe('e5');
    expect(recorded.budgetCents).toBe(7_000_000);
    expect(recorded.purchaseTimeframe).toBe('within_30_days');
    expect(recorded.customerEmail).toBe('dev.achara@example.test');

    const [customer] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM customers
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND email = 'dev.achara@example.test'
    `;
    expect(customer!.count).toBe(1);
  });

  it('never asks again for something already given', async () => {
    const conversation = chat();

    await conversation.say('I would like a callback about the S3');
    await conversation.say('Nadia Brandt, nadia.brandt@example.test, 416 555 0134');
    const reply = await conversation.say('Yes, that is fine');

    expect(reply.toolsUsed).toContain('createCallbackRequest');
    // Name, email and number arrived in one message and none was re-requested.
    expect(reply.text).not.toMatch(/name and email|what number/i);
  });
});

describe('what the customer is never shown', () => {
  it('sees no priority, score or rationale in any reply', async () => {
    const conversation = chat();
    const { conversationId } = await conversation.session;

    const replies = [
      await conversation.say('I want the S5 Premium, buying this week with $55,000 ready'),
      await conversation.say('I would like to speak to a salesperson'),
      await conversation.say('Pia Lindgren, pia.lindgren@example.test'),
      await conversation.say('Yes, that is fine'),
    ];

    const result = await scoreOf(conversationId);
    expect(result.priority).toBe('high');

    const everythingSaid = replies.map((reply) => reply.text).join('\n').toLowerCase();
    for (const forbidden of ['priority', 'score', 'rationale', 'high', 'lead', 'signal']) {
      expect(everythingSaid, forbidden).not.toContain(forbidden);
    }
    // Nor an internal identifier of any kind.
    expect(everythingSaid).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('the customer record', () => {
  it('carries the consent the assistant actually collected', async () => {
    const conversation = chat();

    await conversation.say('Please call me about the T4');
    await conversation.say('Kai Ostrowski, kai.ostrowski@example.test, 416 555 0177');
    await conversation.say('Yes, that is fine');

    const [customer] = await admin<{ contact_consent: boolean }[]>`
      SELECT contact_consent FROM customers
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND email = 'kai.ostrowski@example.test'
    `;
    expect(customer!.contact_consent).toBe(true);
  });
});
