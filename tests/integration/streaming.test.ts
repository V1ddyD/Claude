import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prepareDatabase } from '../helpers/db';
import { ScriptedModel } from '../helpers/scripted-model';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { respondToMessage } from '../../src/server/ai/conversation';
import { ensureConversation } from '../../src/server/ai/extraction';
import { getAvailableTestDriveSlots } from '../../src/server/services/booking';

/**
 * Streaming.
 *
 * The customer sees text as it is written and a plain-language note while a
 * tool runs. What must NOT happen: internal tool names on screen, a reply that
 * rewrites itself after the customer has read it, or a stream that stops
 * silently when something fails.
 */

const TENANT = { timezone: 'America/Toronto', locale: 'en-CA', ticketPrefix: 'SIN' };

beforeAll(async () => {
  await prepareDatabase();
});
afterAll(async () => {
  await closeConnections();
});

async function collect(userMessage: string, client: ScriptedModel) {
  const session = await ensureConversation(SINCLAIR_TENANT_ID, {});
  const deltas: string[] = [];
  const statuses: string[] = [];

  const reply = await respondToMessage({
    tenantId: SINCLAIR_TENANT_ID,
    conversationId: session.conversationId,
    visitorId: session.visitorId,
    userMessage,
    requestId: 'test',
    client,
    stream: {
      onDelta: (text) => deltas.push(text),
      onStatus: (status) => statuses.push(status),
    },
  });

  return { reply, deltas, statuses, session };
}

describe('text delivery', () => {
  it('arrives in pieces, and the pieces are the whole reply', async () => {
    const { reply, deltas } = await collect(
      'Tell me about the S5',
      new ScriptedModel([{ text: 'The S5 is our premium mid-size SUV.' }]),
    );

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(reply.text);
  });

  it('streams a preamble before a tool call, then the answer', async () => {
    const { reply, deltas } = await collect(
      'What trims does the S5 have?',
      new ScriptedModel([
        { text: 'Let me check that.', toolUses: [{ name: 'getVehicleTrims', input: { modelSlug: 's5' } }] },
        { text: 'Core, Premium and Luxury.' },
      ]),
    );

    const streamed = deltas.join('');
    expect(streamed).toContain('Let me check that.');
    expect(streamed).toContain('Core, Premium and Luxury.');

    // Both utterances are kept: the customer has already watched the preamble
    // appear, so replacing it would contradict what is on screen.
    expect(reply.text).toContain('Let me check that.');
    expect(reply.text).toContain('Core, Premium and Luxury.');
  });
});

describe('progress while a tool runs', () => {
  it('says what the dealership is doing, never a tool name', async () => {
    const { statuses } = await collect(
      'Any S5s in stock?',
      new ScriptedModel([
        { toolUses: [{ name: 'checkInventory', input: { modelSlug: 's5' } }] },
        { text: 'We have two.' },
      ]),
    );

    expect(statuses).toEqual(['Checking what we have in stock']);
    for (const status of statuses) {
      expect.soft(status).not.toMatch(/checkInventory|tool|API|query|database/i);
    }
  });

  it('has a phrase for every tool the assistant can call', async () => {
    // A missing entry means the customer watches a spinner with no explanation
    // while something takes a few seconds.
    const { TOOLS } = await import('../../src/server/ai/tools');
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/server/ai/conversation.ts', 'utf8'),
    );

    const missing = TOOLS.map((t) => t.name).filter((name) => !source.includes(`${name}:`));
    expect(missing).toEqual([]);
  });
});

describe('a completed action', () => {
  it('streams the receipt alongside the text', async () => {
    const slots = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      getAvailableTestDriveSlots(db, TENANT, {
        from: new Date(Date.now() + 3 * 864e5),
        to: new Date(Date.now() + 11 * 864e5),
        modelSlug: 's5',
      }),
    );

    const { reply, statuses } = await collect(
      'Book me in',
      new ScriptedModel([
        {
          toolUses: [{
            name: 'createTestDrive',
            input: {
              startsAt: slots[0]!.startsAt.toISOString(),
              modelSlug: 's5',
              fullName: 'Stream Test',
              email: `stream.${Date.now()}@example.test`,
              phone: '+1 416 555 0100',
              contactConsent: true,
            },
          }],
        },
        { text: "You're booked." },
      ]),
    );

    expect(statuses).toContain('Booking that in');
    expect(reply.receipt?.ticketNumber).toMatch(/^SIN-\d{4}-\d+$/);
    // Queued is not delivered, and the wording says so.
    expect(reply.receipt?.confirmationEmail).toContain('queued');
  });
});

describe('degraded mode', () => {
  it('still streams, so the interface has one path rather than two', async () => {
    const session = await ensureConversation(SINCLAIR_TENANT_ID, {});
    const deltas: string[] = [];

    const reply = await respondToMessage({
      tenantId: SINCLAIR_TENANT_ID,
      conversationId: session.conversationId,
      visitorId: session.visitorId,
      userMessage: 'Hello?',
      requestId: 'test',
      client: null,
      stream: { onDelta: (text) => deltas.push(text) },
    });

    expect(reply.degraded).toBe(true);
    expect(deltas.join('')).toBe(reply.text);
  });
});
