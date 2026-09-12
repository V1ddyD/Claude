import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { prepareDatabase } from '../helpers/db';
import { ScriptedModel } from '../helpers/scripted-model';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { messages } from '../../src/server/db/schema';
import { respondToMessage } from '../../src/server/ai/conversation';
import { ensureConversation } from '../../src/server/ai/extraction';

/**
 * The turn's transcript.
 *
 * A turn's rows are held in memory and written as one statement at the end,
 * numbered from the count loaded with the history rather than from a fresh
 * `max(seq) + 1` before each insert. That saved two round trips per row on a
 * remote database — and these tests are what say it did not cost correctness:
 * the order, the numbering and the uniqueness constraint the old read-then-
 * insert could race against.
 */

beforeAll(async () => {
  await prepareDatabase();
});
afterAll(async () => {
  await closeConnections();
});

async function transcriptOf(conversationId: string) {
  return withTenant(SINCLAIR_TENANT_ID, (db) =>
    db
      .select({ seq: messages.seq, role: messages.role, toolName: messages.toolName })
      .from(messages)
      .where(
        and(eq(messages.tenantId, db.tenantId), eq(messages.conversationId, conversationId)),
      )
      .orderBy(asc(messages.seq)),
  );
}

describe('a turn that calls tools', () => {
  it('records the customer, every tool and the reply, in that order', async () => {
    const session = await ensureConversation(SINCLAIR_TENANT_ID, {});

    await respondToMessage({
      tenantId: SINCLAIR_TENANT_ID,
      conversationId: session.conversationId,
      visitorId: session.visitorId,
      userMessage: 'What colours does the S5 come in, and what is in stock?',
      requestId: 'test',
      client: new ScriptedModel([
        {
          toolUses: [
            { name: 'getVehicleColours', input: { modelSlug: 's5' } },
            { name: 'searchVehicles', input: { modelSlug: 's5' } },
          ],
        },
        { text: 'Five paints, and five cars on the ground.' },
      ]),
    });

    const rows = await transcriptOf(session.conversationId);

    expect(rows.map((r) => r.role)).toEqual(['user', 'tool', 'tool', 'assistant']);
    expect(rows.map((r) => r.toolName)).toEqual([
      null,
      'getVehicleColours',
      'searchVehicles',
      null,
    ]);
    // Contiguous from one: a gap or a repeat would mean the numbering drifted
    // from what the unique constraint on (conversation_id, seq) allows.
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it('continues the numbering across turns', async () => {
    const session = await ensureConversation(SINCLAIR_TENANT_ID, {});

    for (const text of ['Hello', 'Tell me about the S5', 'Thanks']) {
      await respondToMessage({
        tenantId: SINCLAIR_TENANT_ID,
        conversationId: session.conversationId,
        visitorId: session.visitorId,
        userMessage: text,
        requestId: 'test',
        client: new ScriptedModel([{ text: 'Of course.' }]),
      });
    }

    const rows = await transcriptOf(session.conversationId);

    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.map((r) => r.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
    ]);
  });

  it('shows the model the customer message it is answering', async () => {
    const session = await ensureConversation(SINCLAIR_TENANT_ID, {});
    const client = new ScriptedModel([{ text: 'Of course.' }]);

    await respondToMessage({
      tenantId: SINCLAIR_TENANT_ID,
      conversationId: session.conversationId,
      visitorId: session.visitorId,
      userMessage: 'Do you have the S5 in white?',
      requestId: 'test',
      client,
    });

    // The message is no longer written before the history is read, so it has
    // to be carried into the request in memory. If that were dropped the
    // assistant would be answering the previous turn.
    const sent = client.requests[0]!.messages;
    expect(sent[sent.length - 1]).toMatchObject({
      role: 'user',
      content: 'Do you have the S5 in white?',
    });
  });
});
