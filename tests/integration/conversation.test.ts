import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { ScriptedModel } from '../helpers/scripted-model';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { respondToMessage } from '../../src/server/ai/conversation';
import { extractAndScore, ensureConversation } from '../../src/server/ai/extraction';
import { getAvailableTestDriveSlots } from '../../src/server/services/booking';

/**
 * The conversation spine, end to end.
 *
 * The model is scripted, so these assert OUR behaviour — tool dispatch,
 * grounding, persistence, idempotency, extraction, scoring and the leak
 * boundary — rather than what a model happened to say.
 */

let admin: Sql;
const TENANT = { timezone: 'America/Toronto', locale: 'en-CA', ticketPrefix: 'SIN' };

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

let visitorId: string;

async function newConversation(): Promise<string> {
  const session = await ensureConversation(SINCLAIR_TENANT_ID, {});
  visitorId = session.visitorId;
  return session.conversationId;
}

/**
 * The next slot the dealership could actually take a booking for.
 *
 * These cases each need *a* slot; which one is immaterial. They used to name a
 * single 24-hour window near the far edge of the booking horizon, which
 * quietly assumed the dealership is open that day. It is closed on Sundays, so
 * roughly one run in seven asked for a window with no open hours in it and
 * failed on the calendar rather than on a defect.
 *
 * Widening the window was not enough either: nothing beyond
 * `maxHorizonDays` (14) is bookable at all, so a week starting at +13 days is
 * a week of nothing. Searching the whole horizon is what makes this a question
 * about availability rather than about today's date.
 *
 * Successive calls return different slots without being asked to: a booked
 * slot stops being available, which is the property under test elsewhere.
 */
async function nextFreeSlot(): Promise<Date> {
  const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
    getAvailableTestDriveSlots(db, TENANT, {
      from: new Date(),
      to: new Date(Date.now() + 14 * 864e5),
    }),
  );

  const slot = slots[0];
  if (!slot) throw new Error('No test-drive slot available anywhere in the booking horizon');
  return slot.startsAt;
}

function ask(conversationId: string, userMessage: string, client: ScriptedModel) {
  return respondToMessage({
    tenantId: SINCLAIR_TENANT_ID,
    conversationId,
    visitorId,
    userMessage,
    requestId: 'test',
    client,
  });
}

describe('answering a question', () => {
  it('calls a tool and returns the reply', async () => {
    const conversationId = await newConversation();
    const model = new ScriptedModel([
      { toolUses: [{ name: 'getVehicleTrims', input: { modelSlug: 's5' } }] },
      { text: 'The S5 comes in Core, Premium and Luxury. Premium starts at $58,900.' },
    ]);

    const reply = await ask(conversationId, 'What trims does the S5 come in?', model);

    expect(reply.toolsUsed).toEqual(['getVehicleTrims']);
    expect(reply.text).toContain('Premium');
    expect(reply.degraded).toBe(false);
  });

  it('persists the turn, including the tool call, for staff to read', async () => {
    const conversationId = await newConversation();
    const model = new ScriptedModel([
      { toolUses: [{ name: 'getVehicle', input: { modelSlug: 'e5' } }] },
      { text: 'The E5 is our premium electric SUV.' },
    ]);
    await ask(conversationId, 'Tell me about the E5', model);

    const rows = await admin<{ role: string; tool_name: string | null }[]>`
      SELECT role, tool_name FROM messages WHERE conversation_id = ${conversationId} ORDER BY seq
    `;
    expect(rows.map((r) => r.role)).toEqual(['user', 'tool', 'assistant']);
    expect(rows[1]!.tool_name).toBe('getVehicle');
  });

  it('gives the model a typed error it can relay, not a crash', async () => {
    const conversationId = await newConversation();
    const model = new ScriptedModel([
      { toolUses: [{ name: 'getVehicle', input: { modelSlug: 'zz9' } }] },
      { text: "We don't have a model by that name, but I can show you what we do have." },
    ]);

    const reply = await ask(conversationId, 'Tell me about the ZZ9', model);
    expect(reply.text).toContain("don't have");

    const [toolRow] = await admin<{ tool_result: { code?: string } }[]>`
      SELECT tool_result FROM messages
      WHERE conversation_id = ${conversationId} AND role = 'tool' ORDER BY seq LIMIT 1
    `;
    expect(toolRow!.tool_result.code).toBe('NOT_FOUND');
  });
});

describe('limits', () => {
  it('allows only one write per customer message', async () => {
    const conversationId = await newConversation();
    const startsAt = await nextFreeSlot();

    const booking = (email: string) => ({
      name: 'createTestDrive',
      input: {
        startsAt: startsAt.toISOString(),
        fullName: 'Double Booker', email, phone: '+1 416 555 0100', contactConsent: true,
      },
    });

    const model = new ScriptedModel([
      { toolUses: [booking('one@example.test'), booking('two@example.test')] },
      { text: 'Booked.' },
    ]);

    await ask(conversationId, 'Book me two test drives', model);

    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM appointments
      WHERE lead_id IN (SELECT id FROM leads WHERE conversation_id = ${conversationId})
    `;
    // No single message may create a lead, a ticket and two appointments.
    expect(row?.count).toBe(1);
  });

  it('stops after the tool-call ceiling rather than looping forever', async () => {
    const conversationId = await newConversation();
    const model = new ScriptedModel(
      // A model that never stops asking for tools.
      Array.from({ length: 20 }, () => ({
        text: 'Let me check.',
        toolUses: [{ name: 'getVehicle', input: { modelSlug: 's5' } }],
      })),
    );

    const reply = await ask(conversationId, 'Loop please', model);
    expect(reply.toolsUsed.length).toBeLessThanOrEqual(6);
  });
});

describe('idempotency', () => {
  it('returns the first booking when the same call is retried', async () => {
    const conversationId = await newConversation();
    const startsAt = await nextFreeSlot();
    const call = {
      name: 'createTestDrive',
      input: {
        startsAt: startsAt.toISOString(),
        fullName: 'Retry Customer',
        email: 'retry@example.test',
        phone: '+1 416 555 0100',
        contactConsent: true,
      },
    };

    await ask(conversationId, 'Book it', new ScriptedModel([
      { toolUses: [call] }, { text: 'Booked.' },
    ]));
    // The same request again — a network retry, a double-submit, a re-run.
    await ask(conversationId, 'Book it again', new ScriptedModel([
      { toolUses: [call] }, { text: 'Already booked.' },
    ]));

    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM appointments
      WHERE lead_id IN (SELECT id FROM leads WHERE conversation_id = ${conversationId})
    `;
    expect(row?.count).toBe(1);
  });
});

describe('a failed write tool', () => {
  it('leaves nothing behind', async () => {
    const conversationId = await newConversation();

    // A booking for a model with no demonstrator fails inside the service,
    // AFTER the tool has already created a customer and a lead. Without a
    // savepoint per tool, those partial writes would commit with the rest of
    // the conversation — a lead with no appointment behind it.
    const model = new ScriptedModel([
      {
        toolUses: [{
          name: 'createTestDrive',
          input: {
            startsAt: new Date(Date.now() + 9 * 864e5).toISOString(),
            modelSlug: 'no-such-model',
            fullName: 'Partial Write', email: 'partial@example.test', phone: '+1 416 555 0100', contactConsent: true,
          },
        }],
      },
      { text: 'I could not book that.' },
    ]);

    await ask(conversationId, 'Book a test drive', model);

    const [lead] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM leads WHERE conversation_id = ${conversationId}
    `;
    const [customer] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM customers WHERE email = 'partial@example.test'
    `;

    expect(lead?.count).toBe(0);
    expect(customer?.count).toBe(0);

    // The conversation itself survives — only the tool's writes were undone.
    const [messageCount] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM messages WHERE conversation_id = ${conversationId}
    `;
    expect(messageCount!.count).toBeGreaterThan(0);
  });
});

describe('the leak boundary', () => {
  it('never shows the model internal fields from a tool result', async () => {
    const conversationId = await newConversation();
    const model = new ScriptedModel([
      { toolUses: [{ name: 'checkInventory', input: { modelSlug: 's5' } }] },
      { text: 'We have a few in stock.' },
    ]);
    await ask(conversationId, 'Any S5s in stock?', model);

    const seen = model.everythingSeen();
    for (const forbidden of [
      'acquisitionCost', 'reservedForCustomerId', 'internalNotes',
      'scoreRationale', 'aiSummary', 'priority', 'assignedStaffId', 'audit',
    ]) {
      expect.soft(seen, `"${forbidden}" reached the model`).not.toContain(forbidden);
    }
  });

  it('never places a lead score in the customer-facing context', async () => {
    const conversationId = await newConversation();
    const model = new ScriptedModel([{ text: 'Happy to help.' }]);
    await ask(conversationId, 'Hello', model);

    // Pass A has no route to internal state: the context is built from the
    // catalogue and the transcript, and nothing else.
    expect(model.everythingSeen()).not.toMatch(/lead_score|score_rationale|HIGH priority/i);
  });
});

describe('degraded mode', () => {
  it('answers honestly and offers the team when the model is unavailable', async () => {
    const conversationId = await newConversation();
    const reply = await respondToMessage({
      tenantId: SINCLAIR_TENANT_ID,
      conversationId,
      visitorId,
      userMessage: 'Hello?',
      requestId: 'test',
      client: null,
    });

    expect(reply.degraded).toBe(true);
    expect(reply.text).toContain('team');
    // It must not invent an answer or pretend a person has replied.
    expect(reply.text).not.toMatch(/\$\d|in stock|booked/i);
  });
});

describe('extraction and scoring', () => {
  it('does nothing when nobody has identified themselves', async () => {
    const conversationId = await newConversation();
    const result = await extractAndScore({
      tenantId: SINCLAIR_TENANT_ID,
      conversationId,
      client: new ScriptedModel([{ toolUses: [{ name: 'record_signals', input: {} }] }]),
    });
    // An anonymous browser is not a lead. Creating one would fill the portal
    // with records staff cannot act on.
    expect(result.skipped).toBe('no-lead');
  });

  it('discards output that does not validate rather than coercing it', async () => {
    const conversationId = await newConversation();
    const startsAt = await nextFreeSlot();
    await ask(conversationId, 'Book it', new ScriptedModel([
      {
        toolUses: [{
          name: 'createTestDrive',
          input: {
            startsAt: startsAt.toISOString(),
            fullName: 'Schema Test', email: 'schema@example.test', phone: '+1 416 555 0100', contactConsent: true,
          },
        }],
      },
      { text: 'Booked.' },
    ]));

    const result = await extractAndScore({
      tenantId: SINCLAIR_TENANT_ID,
      conversationId,
      client: new ScriptedModel([
        {
          toolUses: [{
            name: 'record_signals',
            // A budget with no confidence, and an invented timeframe.
            input: { budgetCents: { value: 50000 }, purchaseTimeframe: { value: 'soon', confidence: 0.9 } },
          }],
        },
      ]),
    });

    expect(result.skipped).toBe('invalid-output');

    const [lead] = await admin<{ budget_cents: number | null }[]>`
      SELECT budget_cents FROM leads WHERE conversation_id = ${conversationId}
    `;
    expect(lead!.budget_cents).toBeNull();
  });
});
