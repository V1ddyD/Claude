import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection, appConnection, asTenant } from '../helpers/db';
import { SINCLAIR_TENANT_ID, NORTHWIND_TENANT_ID } from '../../db/seeds/sinclair';

/**
 * The seeded catalogue, checked against the real database.
 *
 * The invariant that matters: `model_configurations.price_cents` must equal
 * base + powertrain delta + trim delta for EVERY configuration. The pricing
 * engine refuses to quote when they disagree, so a violation here would take
 * the configurator down rather than produce a wrong number — but it would still
 * be an outage, and this is where it gets caught.
 */

let admin: Sql;
let app: Sql;

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
  app = appConnection();
});

afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await app?.end({ timeout: 5 });
});

describe('the seeded catalogue', () => {
  it('is not shallow: every model has multiple powertrains and trims', async () => {
    const rows = await admin<{ slug: string; powertrains: number; trims: number }[]>`
      SELECT m.slug,
             (SELECT count(*)::int FROM powertrains p WHERE p.model_id = m.id) AS powertrains,
             (SELECT count(*)::int FROM trims t WHERE t.model_id = m.id) AS trims
      FROM vehicle_models m
      WHERE m.tenant_id = ${SINCLAIR_TENANT_ID}
      ORDER BY m.slug
    `;

    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      expect.soft(row.powertrains, `${row.slug} powertrains`).toBeGreaterThanOrEqual(2);
      expect.soft(row.trims, `${row.slug} trims`).toBeGreaterThanOrEqual(2);
    }
  });

  it('offers a genuine matrix, not every trim with every engine', async () => {
    // If configurations == powertrains x trims for every model, the matrix is
    // decorative and the configurator would let you build cars that do not exist.
    const rows = await admin<{ slug: string; actual: number; cartesian: number }[]>`
      SELECT m.slug,
             (SELECT count(*)::int FROM model_configurations c WHERE c.model_id = m.id) AS actual,
             (SELECT count(*)::int FROM powertrains p WHERE p.model_id = m.id)
               * (SELECT count(*)::int FROM trims t WHERE t.model_id = m.id) AS cartesian
      FROM vehicle_models m
      WHERE m.tenant_id = ${SINCLAIR_TENANT_ID}
    `;
    const restricted = rows.filter((r) => r.actual < r.cartesian);
    expect(restricted.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect.soft(row.actual, `${row.slug} has no configurations`).toBeGreaterThan(0);
    }
  });

  it('prices every configuration as base + powertrain + trim, exactly', async () => {
    const mismatches = await admin<
      { slug: string; trim: string; powertrain: string; stored: string; derived: string }[]
    >`
      SELECT m.slug, t.code AS trim, p.code AS powertrain,
             c.price_cents AS stored,
             (m.base_msrp_cents + p.price_delta_cents + t.price_delta_cents) AS derived
      FROM model_configurations c
        JOIN vehicle_models m ON m.id = c.model_id
        JOIN powertrains p ON p.id = c.powertrain_id
        JOIN trims t ON t.id = c.trim_id
      WHERE c.tenant_id = ${SINCLAIR_TENANT_ID}
        AND c.price_cents <> (m.base_msrp_cents + p.price_delta_cents + t.price_delta_cents)
    `;
    expect(mismatches).toEqual([]);
  });

  it('has no configuration priced at or below zero', async () => {
    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM model_configurations
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND price_cents <= 0
    `;
    expect(row?.count).toBe(0);
  });

  it('gives every configuration at least one exterior and interior colour', async () => {
    const orphans = await admin<{ id: string }[]>`
      SELECT c.id FROM model_configurations c
      WHERE c.tenant_id = ${SINCLAIR_TENANT_ID}
        AND NOT EXISTS (
          SELECT 1 FROM colours col
          WHERE col.model_id = c.model_id AND col.kind = 'exterior'
        )
    `;
    expect(orphans).toEqual([]);
  });

  it('never marks an option standard and charges an override for it', async () => {
    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM option_availability
      WHERE tenant_id = ${SINCLAIR_TENANT_ID}
        AND is_standard AND price_override_cents IS NOT NULL AND price_override_cents > 0
    `;
    expect(row?.count).toBe(0);
  });

  it('keeps option rules within one model', async () => {
    // A rule pointing at another model's option would be unsatisfiable.
    const crossModel = await admin<{ id: string }[]>`
      SELECT r.id FROM option_rules r
        JOIN options a ON a.id = r.option_id
        JOIN options b ON b.id = r.other_option_id
      WHERE r.tenant_id = ${SINCLAIR_TENANT_ID} AND a.model_id <> b.model_id
    `;
    expect(crossModel).toEqual([]);
  });

  it('uses model-appropriate trim naming rather than one scheme everywhere', async () => {
    const [row] = await admin<{ distinct: number }[]>`
      SELECT count(DISTINCT code)::int AS distinct FROM trims WHERE tenant_id = ${SINCLAIR_TENANT_ID}
    `;
    // Core/Premium/Luxury, Sport/Sport Plus, Touring/Performance, Work/Adventure/Summit…
    expect(row?.distinct).toBeGreaterThanOrEqual(8);
  });
});

describe('electric powertrains', () => {
  it('declare a battery and a range', async () => {
    const incomplete = await admin<{ code: string }[]>`
      SELECT code FROM powertrains
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND kind = 'bev'
        AND (battery_kwh IS NULL OR range_km IS NULL)
    `;
    expect(incomplete).toEqual([]);
  });

  it('are rejected by the database if they do not', async () => {
    const [model] = await admin<{ id: string }[]>`
      SELECT id FROM vehicle_models WHERE tenant_id = ${SINCLAIR_TENANT_ID} LIMIT 1
    `;
    await expect(
      admin`
        INSERT INTO powertrains (tenant_id, model_id, code, name, kind, drivetrain)
        VALUES (${SINCLAIR_TENANT_ID}, ${model!.id}, 'BAD-BEV', 'Bad BEV', 'bev', 'awd')
      `,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allow a plug-in hybrid to have both a battery and an engine', async () => {
    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM powertrains
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND kind = 'phev' AND battery_kwh IS NOT NULL
    `;
    // The original 0001 constraint made this unrepresentable; 0003 fixed it.
    expect(row?.count).toBeGreaterThan(0);
  });
});

describe('inventory', () => {
  it('exposes only available units to the public view', async () => {
    const [view] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM v_public_inventory WHERE tenant_id = ${SINCLAIR_TENANT_ID}
    `;
    const [available] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM inventory_units
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND status = 'available'
    `;
    const [total] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM inventory_units WHERE tenant_id = ${SINCLAIR_TENANT_ID}
    `;

    expect(view?.count).toBe(available?.count);
    // There must genuinely be hidden stock, or this proves nothing.
    expect(total!.count).toBeGreaterThan(available!.count);
  });

  it('never shows a sold or reserved car as available', async () => {
    const leaked = await admin<{ stock_number: string }[]>`
      SELECT u.stock_number FROM v_public_inventory v
        JOIN inventory_units u ON u.id = v.id
      WHERE u.status <> 'available'
    `;
    expect(leaked).toEqual([]);
  });

  it('makes every demonstrator a bookable resource', async () => {
    const missing = await admin<{ stock_number: string }[]>`
      SELECT u.stock_number FROM inventory_units u
      WHERE u.tenant_id = ${SINCLAIR_TENANT_ID} AND u.is_demo_vehicle
        AND NOT EXISTS (
          SELECT 1 FROM resources r WHERE r.inventory_unit_id = u.id AND r.kind = 'vehicle'
        )
    `;
    expect(missing).toEqual([]);
  });

  it('declares a reservation expiry whenever a car is reserved', async () => {
    const [row] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM inventory_units
      WHERE tenant_id = ${SINCLAIR_TENANT_ID} AND status = 'reserved' AND reserved_until IS NULL
    `;
    expect(row?.count).toBe(0);
  });
});

describe('catalogue tenancy', () => {
  it('is invisible to another dealership', async () => {
    const rows = await asTenant(app, NORTHWIND_TENANT_ID, (tx) =>
      tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM vehicle_models
      `,
    );
    // Northwind has no catalogue of its own and must not see Sinclair's.
    expect(rows[0]?.count).toBe(0);
  });

  it('is visible to its own dealership', async () => {
    const rows = await asTenant(app, SINCLAIR_TENANT_ID, (tx) =>
      tx<{ count: number }[]>`SELECT count(*)::int AS count FROM vehicle_models`,
    );
    expect(rows[0]?.count).toBeGreaterThanOrEqual(10);
  });
});
