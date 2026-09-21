import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID, NORTHWIND_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { respondToMessage } from '../../src/server/ai/conversation';
import { ensureConversation } from '../../src/server/ai/extraction';
import { RuleBasedModel } from '../../src/server/ai/rule-based';
import { toolRegistry } from '../../src/server/ai/tools';
import { customers, conversations } from '../../src/server/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * Two dealerships, one deployment, through the assistant.
 *
 * tests/isolation/ proves the database refuses cross-tenant reads. This suite
 * proves the same thing one layer up, where a customer is typing: the
 * assistant's vocabulary, its tools, its conversation and its dealership
 * details are all the current tenant's, and there is no message that reaches
 * across (spec §22).
 *
 * Northwind has a catalogue with no model, trim or colour name in common with
 * Sinclair's, which is what makes the boundary observable rather than merely
 * asserted.
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

async function askAs(tenantId: string, message: string) {
  const session = await ensureConversation(tenantId, {});
  return respondToMessage({
    tenantId,
    conversationId: session.conversationId,
    visitorId: session.visitorId,
    userMessage: message,
    requestId: 'isolation',
    client: new RuleBasedModel(),
  });
}

describe('a vehicle belonging to the other dealership', () => {
  it('is not a car the assistant will discuss', async () => {
    // Sinclair's S5 does not exist at Northwind, and Northwind's assistant
    // cannot even recognise the name: its vocabulary is Northwind's range.
    const reply = await askAs(NORTHWIND_TENANT_ID, 'Tell me about the Sinclair S5');

    expect(reply.toolsUsed).not.toContain('getVehicle');
    expect(reply.text).not.toMatch(/mid-size suv/i);
    expect(reply.text).toMatch(/don't (make|build)|no S5/i);
    // And it offers its own range instead.
    expect(reply.text).toContain('Northwind Harrier');
  });

  it('is not reachable by naming its slug either', async () => {
    const reply = await askAs(NORTHWIND_TENANT_ID, 'how much is the e5');
    expect(reply.toolsUsed).not.toContain('calculateVehiclePrice');
    expect(reply.text).not.toMatch(/\$\d/);
  });

  it('cannot be pulled through the tool layer with a known-good slug', async () => {
    // The tool, called directly with the other tenant's slug, refuses. The
    // assistant is not the thing enforcing this.
    const outcome = await withTenant(NORTHWIND_TENANT_ID, (db) =>
      toolRegistry().dispatch(
        {
          tenantId: NORTHWIND_TENANT_ID,
          conversationId: crypto.randomUUID(),
          visitorId: crypto.randomUUID(),
          requestId: 'isolation',
          now: new Date(),
          tenant: {
            brandName: 'Northwind', timezone: 'America/Halifax',
            locale: 'en-CA', currency: 'CAD', ticketPrefix: 'NWD',
          },
          db,
        },
        'getVehicle',
        { modelSlug: 's5' },
      ),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('NOT_FOUND');
  });
});

describe('inventory belonging to the other dealership', () => {
  it('is never counted in a stock answer', async () => {
    const reply = await askAs(NORTHWIND_TENANT_ID, 'Do you have any Harriers in stock?');
    expect(reply.toolsUsed).toContain('checkInventory');

    // Sinclair has stock; Northwind has none. A leak would show Sinclair's.
    const [sinclair] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM inventory_units
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND status = 'available'
    `;
    expect(sinclair!.count).toBeGreaterThan(0);
    expect(reply.text).toMatch(/nothing matching|none of those|nothing like that/i);
    expect(reply.text).not.toMatch(/SIN-\d/);
  });
});

describe('a customer belonging to the other dealership', () => {
  it('is not matched when the same address books at the other dealership', async () => {
    const email = `shared.${Date.now()}@example.test`;

    for (const tenantId of [SINCLAIR_TENANT_ID, NORTHWIND_TENANT_ID]) {
      const session = await ensureConversation(tenantId, {});
      const client = new RuleBasedModel();
      const say = (message: string) =>
        respondToMessage({
          tenantId,
          conversationId: session.conversationId,
          visitorId: session.visitorId,
          userMessage: message,
          requestId: 'isolation',
          client,
        });

      await say('I would like to speak to a salesperson');
      await say(`Sam Shared, ${email}`);
      await say('Yes, that is fine');
    }

    // One person, one address, two dealerships — and two separate records.
    // Sharing them would let either dealership read the other's customer.
    for (const tenantId of [SINCLAIR_TENANT_ID, NORTHWIND_TENANT_ID]) {
      const rows = await withTenant(tenantId, (db) =>
        db
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.tenantId, db.tenantId), eq(customers.email, email))),
      );
      expect(rows).toHaveLength(1);
    }

    const [total] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM customers WHERE email = ${email}
    `;
    expect(total!.count).toBe(2);
  });
});

describe('a conversation belonging to the other dealership', () => {
  it('cannot be continued from the other tenant', async () => {
    const session = await ensureConversation(SINCLAIR_TENANT_ID, {});
    await respondToMessage({
      tenantId: SINCLAIR_TENANT_ID,
      conversationId: session.conversationId,
      visitorId: session.visitorId,
      userMessage: 'Tell me about the S5',
      requestId: 'isolation',
      client: new RuleBasedModel(),
    });

    // Northwind cannot see the row at all.
    const visible = await withTenant(NORTHWIND_TENANT_ID, (db) =>
      db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, session.conversationId)),
    );
    expect(visible).toEqual([]);

    // And writing a message into it fails rather than appending silently.
    await expect(
      respondToMessage({
        tenantId: NORTHWIND_TENANT_ID,
        conversationId: session.conversationId,
        visitorId: session.visitorId,
        userMessage: 'What did I just ask?',
        requestId: 'isolation',
        client: new RuleBasedModel(),
      }),
    ).rejects.toThrow();
  });
});

describe('dealership details', () => {
  it('are the current tenant\'s, never the other\'s', async () => {
    const northwind = await askAs(NORTHWIND_TENANT_ID, 'Where are you located?');
    expect(northwind.text).toContain('Dockside');
    expect(northwind.text).not.toMatch(/sinclair/i);

    const sinclair = await askAs(SINCLAIR_TENANT_ID, 'Where are you located?');
    expect(sinclair.text).not.toContain('Dockside');
  });

  it('name the current tenant when greeting', async () => {
    const reply = await askAs(NORTHWIND_TENANT_ID, 'Hello');
    expect(reply.text).toContain('Northwind');
    expect(reply.text).not.toContain('Sinclair');
  });
});
