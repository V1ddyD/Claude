import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prepareDatabase } from '../helpers/db';
import { ScriptedModel } from '../helpers/scripted-model';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { respondToMessage } from '../../src/server/ai/conversation';
import { ensureConversation } from '../../src/server/ai/extraction';
import { buildPinnedFacts } from '../../src/server/ai/context';

/**
 * Conversation memory (spec §49).
 *
 * The customer should never have to say the same thing twice, and an
 * unqualified "the Premium" should resolve to the car they are looking at.
 */

beforeAll(async () => {
  await prepareDatabase();
});
afterAll(async () => {
  await closeConnections();
});

async function conversation() {
  const session = await ensureConversation(SINCLAIR_TENANT_ID, {});
  return {
    ...session,
    ask: (userMessage: string, client: ScriptedModel) =>
      respondToMessage({
        tenantId: SINCLAIR_TENANT_ID,
        conversationId: session.conversationId,
        visitorId: session.visitorId,
        userMessage,
        requestId: 'test',
        client,
      }),
  };
}

describe('the current subject', () => {
  it('is carried into the next turn', async () => {
    const { ask } = await conversation();

    await ask(
      'Tell me about the S5',
      new ScriptedModel([
        { toolUses: [{ name: 'getVehicle', input: { modelSlug: 's5' } }] },
        { text: 'The S5 is our mid-size SUV.' },
      ]),
    );

    // The customer now says "the Premium" without naming a model.
    const second = new ScriptedModel([
      { toolUses: [{ name: 'getVehicleTrims', input: { modelSlug: 's5' } }] },
      { text: 'The Premium starts at $56,400.' },
    ]);
    await ask('How much is the Premium?', second);

    expect(second.requests[0]!.system).toContain('S5');
    expect(second.requests[0]!.system).toContain('Currently looking at');
  });

  it('follows the customer when they switch models', async () => {
    const { conversationId, ask } = await conversation();

    await ask('Tell me about the S5', new ScriptedModel([
      { toolUses: [{ name: 'getVehicle', input: { modelSlug: 's5' } }] },
      { text: 'The S5...' },
    ]));
    await ask('What about the E5?', new ScriptedModel([
      { toolUses: [{ name: 'getVehicle', input: { modelSlug: 'e5' } }] },
      { text: 'The E5...' },
    ]));

    const pinned = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      buildPinnedFacts(db, conversationId),
    );
    // Most recent wins, rather than the two being averaged or accumulated.
    expect(pinned.subject.modelSlug).toBe('e5');
  });
});

describe('what the customer has told us', () => {
  it('is pinned so they are not asked twice', async () => {
    const { ask } = await conversation();

    await ask(
      "I'm Alex Morgan, alex.context@example.test. Budget is about $55,000 and I have a trade-in.",
      new ScriptedModel([
        {
          toolUses: [{
            name: 'updateContactPreferences',
            input: {
              fullName: 'Alex Morgan', email: 'alex.context@example.test',
              contactConsent: true, preferredContact: 'email',
            },
          }],
        },
        { text: 'Thank you.' },
      ]),
    );

    const next = new ScriptedModel([{ text: 'Of course.' }]);
    await ask('What would you recommend?', next);

    const system = next.requests[0]!.system;
    expect(system).toContain('Their name is Alex Morgan');
    expect(system).toContain('Do not ask for any of this again');
  });

  it('never pins internal state or contact details', async () => {
    const { ask } = await conversation();

    await ask('Book a callback', new ScriptedModel([
      {
        toolUses: [{
          name: 'createCallbackRequest',
          input: {
            fullName: 'Private Person', email: 'private@example.test',
            phone: '+1 416 555 0000', contactConsent: true,
          },
        }],
      },
      { text: 'Someone will call.' },
    ]));

    const next = new ScriptedModel([{ text: 'Sure.' }]);
    await ask('Anything else?', next);
    const system = next.requests[0]!.system;

    // The assistant has no reason to repeat these back, and a prompt is the
    // wrong place to carry them.
    expect(system).not.toContain('private@example.test');
    expect(system).not.toContain('555 0000');
    // And nothing internal, ever.
    expect(system).not.toMatch(/priority|score|rationale|lead id/i);
  });
});
