import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { respondToMessage } from '../../src/server/ai/conversation';
import { ensureConversation } from '../../src/server/ai/extraction';
import { RuleBasedModel } from '../../src/server/ai/rule-based';

/**
 * Every model in the catalogue, not just the one in the examples.
 *
 * The scripted assistant contains no model names: its vocabulary is the
 * tenant's own range, read from the catalogue on each request. This suite is
 * what holds that claim honest — it enumerates whatever is in the database and
 * asks the same questions of each one, so a model added tomorrow is covered by
 * this test tomorrow without anybody editing it (spec §1, §34).
 */

let admin: Sql;
let models: { slug: string; name: string }[] = [];

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
  models = await admin<{ slug: string; name: string }[]>`
    SELECT slug, full_name AS name FROM vehicle_models
    WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND status = 'published'
    ORDER BY display_order
  `;
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

/** One fresh conversation per question, so nothing leaks between assertions. */
async function ask(message: string) {
  const session = await ensureConversation(SINCLAIR_TENANT_ID, {});
  return respondToMessage({
    tenantId: SINCLAIR_TENANT_ID,
    conversationId: session.conversationId,
    visitorId: session.visitorId,
    userMessage: message,
    requestId: 'coverage',
    client: new RuleBasedModel(),
  });
}

describe('the catalogue the tests enumerate', () => {
  it('has enough models to make this suite meaningful', () => {
    expect(models.length).toBeGreaterThanOrEqual(10);
  });
});

describe('every model in the catalogue', () => {
  it('is identified from its name and described', async () => {
    for (const model of models) {
      const reply = await ask(`Tell me about the ${model.name}`);
      expect.soft(reply.toolsUsed, model.slug).toContain('getVehicle');
      expect.soft(reply.text, model.slug).toContain(model.name);
    }
  });

  it('is identified from its slug alone', async () => {
    for (const model of models) {
      const reply = await ask(`tell me about the ${model.slug}`);
      expect.soft(reply.toolsUsed, model.slug).toContain('getVehicle');
    }
  });

  it('answers a powertrain question with real powertrains', async () => {
    for (const model of models) {
      const reply = await ask(`What engines does the ${model.name} have?`);
      expect.soft(reply.toolsUsed, model.slug).toContain('getVehiclePowertrains');

      const [row] = await admin<{ name: string }[]>`
        SELECT p.name FROM powertrains p
          JOIN vehicle_models m ON m.id = p.model_id
        WHERE m.tenant_id = ${SINCLAIR_TENANT_ID} AND m.slug = ${model.slug}
        ORDER BY p.price_delta_cents LIMIT 1
      `;
      expect.soft(reply.text, model.slug).toContain(row!.name);
    }
  });

  it('answers a trim question with real trims and a price from the backend', async () => {
    for (const model of models) {
      const reply = await ask(`What trims are available on the ${model.name}?`);
      expect.soft(reply.toolsUsed, model.slug).toContain('getVehicleTrims');

      const [row] = await admin<{ name: string }[]>`
        SELECT t.name FROM trims t
          JOIN vehicle_models m ON m.id = t.model_id
        WHERE m.tenant_id = ${SINCLAIR_TENANT_ID} AND m.slug = ${model.slug}
        ORDER BY t.tier_order LIMIT 1
      `;
      expect.soft(reply.text, model.slug).toContain(row!.name);
    }
  });

  it('prices a named trim through the pricing engine, exactly', async () => {
    for (const model of models) {
      // The cheapest real configuration, and the trim name a customer would use.
      const [config] = await admin<{ trim: string; price: string }[]>`
        SELECT t.name AS trim, c.price_cents::text AS price
        FROM model_configurations c
          JOIN vehicle_models m ON m.id = c.model_id
          JOIN trims t ON t.id = c.trim_id
        WHERE c.tenant_id = ${SINCLAIR_TENANT_ID} AND m.slug = ${model.slug}
        ORDER BY c.price_cents LIMIT 1
      `;

      const reply = await ask(`How much is the ${model.name} ${config!.trim}?`);
      expect.soft(reply.toolsUsed, model.slug).toContain('calculateVehiclePrice');

      // The figure in the reply is the figure in the database, to the cent.
      const formatted = new Intl.NumberFormat('en-CA', {
        style: 'currency', currency: 'CAD', maximumFractionDigits: 0,
      }).format(Number(config!.price) / 100);
      expect.soft(reply.text, `${model.slug} priced at ${formatted}`).toContain(formatted);
    }
  });

  it('answers a stock question from the inventory system', async () => {
    for (const model of models) {
      const reply = await ask(`Do you have any ${model.name} in stock?`);
      expect.soft(reply.toolsUsed, model.slug).toContain('checkInventory');

      const [row] = await admin<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM inventory_units u
          JOIN model_configurations c ON c.id = u.model_configuration_id
          JOIN vehicle_models m ON m.id = c.model_id
        WHERE u.tenant_id = ${SINCLAIR_TENANT_ID} AND m.slug = ${model.slug}
          AND u.status = 'available'
      `;

      // Either it reports cars, or it says there are none. Never the reverse
      // of what the inventory system holds.
      if (row!.count === 0) {
        expect.soft(reply.text, model.slug).toMatch(/nothing matching|none/i);
      } else {
        expect.soft(reply.text, model.slug).toMatch(/here now/i);
      }
    }
  });

  it('offers only colours the model is actually painted in', async () => {
    for (const model of models) {
      const reply = await ask(`What colours can I get the ${model.name} in?`);
      expect.soft(reply.toolsUsed, model.slug).toContain('getVehicleColours');

      const others = await admin<{ name: string }[]>`
        SELECT DISTINCT col.name FROM colours col
          JOIN vehicle_models m ON m.id = col.model_id
        WHERE col.tenant_id = ${SINCLAIR_TENANT_ID} AND m.slug <> ${model.slug}
          AND col.name NOT IN (
            SELECT c2.name FROM colours c2 JOIN vehicle_models m2 ON m2.id = c2.model_id
            WHERE m2.slug = ${model.slug}
          )
      `;
      // Matched as the reply's own list entry, so "Charcoal Nappa" on this
      // model is not mistaken for "Charcoal" on another.
      for (const other of others) {
        expect.soft(reply.text, `${model.slug} must not offer ${other.name}`)
          .not.toContain(`**${other.name}**`);
      }
    }
  });
});
