import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID, NORTHWIND_TENANT_ID } from '../../db/seeds/sinclair';
import { listModels } from '../../src/server/services/catalogue';
import { closeConnections } from '../../src/server/db/client';

/**
 * The facts on a model card.
 *
 * What a model runs on and how many are on the floor are computed by correlated
 * subqueries, and a correlated subquery is exactly where a column reference
 * goes wrong quietly. A bare `tenant_id` inside one that has joined two more
 * tenant-scoped tables is ambiguous and Postgres refuses it — which is the good
 * outcome. The bad one is a bare `id` binding to the SUBQUERY's own row, which
 * returns a plausible-looking answer about the wrong vehicle.
 *
 * So these compare the numbers against the same facts counted independently.
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

describe('what a model card says', () => {
  it('names every powertrain kind that model is actually built with', async () => {
    const models = await listModels(SINCLAIR_TENANT_ID);
    expect(models.length).toBeGreaterThan(0);

    const expected = await admin<{ slug: string; kinds: string[] }[]>`
      SELECT m.slug, array_agg(DISTINCT p.kind ORDER BY p.kind) AS kinds
      FROM vehicle_models m
      JOIN model_configurations mc ON mc.model_id = m.id
      JOIN powertrains p ON p.id = mc.powertrain_id
      WHERE m.tenant_id = ${SINCLAIR_TENANT_ID} AND m.status = 'published'
      GROUP BY m.slug
    `;

    for (const row of expected) {
      const model = models.find((m) => m.slug === row.slug);
      expect.soft(model?.powertrainKinds, `powertrains for ${row.slug}`).toEqual(row.kinds);
    }
  });

  it('counts the units on the floor, and says zero rather than nothing', async () => {
    const models = await listModels(SINCLAIR_TENANT_ID);

    const expected = await admin<{ slug: string; available: number }[]>`
      SELECT m.slug, count(iu.id)::int AS available
      FROM vehicle_models m
      LEFT JOIN model_configurations mc ON mc.model_id = m.id
      LEFT JOIN inventory_units iu
        ON iu.model_configuration_id = mc.id AND iu.status = 'available'
      WHERE m.tenant_id = ${SINCLAIR_TENANT_ID} AND m.status = 'published'
      GROUP BY m.slug
    `;

    for (const row of expected) {
      const model = models.find((m) => m.slug === row.slug);
      expect.soft(model?.inStock, `stock for ${row.slug}`).toBe(row.available);
    }

    // "None on the floor" must arrive as the number 0, not as null or a
    // missing field — the card renders what it is given, and an absent count
    // renders as nothing at all.
    //
    // Asserting that some model HAPPENS to have zero stock would test the
    // seed, not the query: on a freshly seeded database every published model
    // has a unit, and the assertion only ever passed on the residue of earlier
    // runs in a long-lived test database.
    for (const model of models) {
      expect.soft(typeof model.inStock, `stock type for ${model.slug}`).toBe('number');
    }
  });

  it('counts only this dealership\'s stock', async () => {
    // The subqueries carry their own tenant predicate on top of RLS. If one
    // correlated to the wrong row, the most likely symptom is a count that
    // includes somebody else's cars.
    const [sinclair, northwind] = await Promise.all([
      listModels(SINCLAIR_TENANT_ID),
      listModels(NORTHWIND_TENANT_ID),
    ]);

    const slugs = new Set(northwind.map((m) => m.slug));
    expect(sinclair.some((m) => slugs.has(m.slug))).toBe(false);

    const total = await admin<{ count: number }[]>`
      SELECT count(*)::int FROM inventory_units
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND status = 'available'
    `;
    const summed = sinclair.reduce((sum, m) => sum + m.inStock, 0);
    expect(summed).toBe(total[0]!.count);
  });
});
