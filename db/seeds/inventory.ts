import type { Sql } from 'postgres';

/**
 * Inventory for the demonstration environment.
 *
 * Deterministic rather than random: a demo that shows different stock on each
 * reset cannot be scripted, and a test cannot assert against it. The
 * pseudo-random generator is seeded, so `db:reset && db:seed` reproduces the
 * same lot every time.
 */

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUS_MIX = [
  'available', 'available', 'available', 'available', 'available',
  'available', 'reserved', 'pending_delivery', 'sold', 'service_hold',
] as const;

const LOCATIONS = ['Lakeshore showroom', 'Lakeshore lot B', 'Port Lands storage'];

export async function seedInventory(sql: Sql, tenantId: string): Promise<number> {
  const random = mulberry32(20260911);

  const configurations = await sql<
    { id: string; priceCents: string; modelSlug: string; trimCode: string }[]
  >`
    SELECT mc.id,
           mc.price_cents AS "priceCents",
           m.slug         AS "modelSlug",
           t.code         AS "trimCode"
    FROM model_configurations mc
      JOIN vehicle_models m ON m.id = mc.model_id
      JOIN trims t ON t.id = mc.trim_id
    WHERE mc.tenant_id = ${tenantId}
    ORDER BY m.display_order, t.tier_order
  `;

  let stockCounter = 1;
  let written = 0;

  for (const config of configurations) {
    // Two units for most configurations, three for the mid-range where a
    // dealership actually carries depth.
    const unitCount = ['PREMIUM', 'CORE', 'SPORT'].includes(config.trimCode) ? 3 : 2;

    const exteriors = await sql<{ id: string }[]>`
      SELECT c.id FROM colours c
        JOIN vehicle_models m ON m.id = c.model_id
      WHERE c.tenant_id = ${tenantId} AND m.slug = ${config.modelSlug} AND c.kind = 'exterior'
      ORDER BY c.display_order
    `;
    const interiors = await sql<{ id: string }[]>`
      SELECT c.id FROM colours c
        JOIN vehicle_models m ON m.id = c.model_id
      WHERE c.tenant_id = ${tenantId} AND m.slug = ${config.modelSlug} AND c.kind = 'interior'
      ORDER BY c.display_order
    `;

    for (let i = 0; i < unitCount; i++) {
      const status = STATUS_MIX[Math.floor(random() * STATUS_MIX.length)]!;
      const exterior = exteriors[Math.floor(random() * exteriors.length)]?.id ?? null;
      const interior = interiors[Math.floor(random() * interiors.length)]?.id ?? null;

      // Roughly one unit in eight is a demonstrator, which is what makes it
      // eligible to be booked for a test drive.
      const isDemo = status === 'available' && random() < 0.14;

      const stockNumber = `SIN-${String(stockCounter++).padStart(4, '0')}`;
      const vin = `SNC${String(stockCounter).padStart(5, '0')}${config.modelSlug.toUpperCase().padEnd(3, 'X')}26`;

      await sql`
        INSERT INTO inventory_units (
          tenant_id, model_configuration_id, exterior_colour_id, interior_colour_id,
          vin, stock_number, status, condition, mileage_km, asking_price_cents,
          location, estimated_delivery_on, reserved_until, is_demo_vehicle
        ) VALUES (
          ${tenantId}, ${config.id}, ${exterior}, ${interior},
          ${vin}, ${stockNumber}, ${status},
          ${isDemo ? 'demo' : 'new'},
          ${isDemo ? Math.floor(random() * 4000) + 500 : 0},
          ${Number(config.priceCents)},
          ${LOCATIONS[Math.floor(random() * LOCATIONS.length)]!},
          ${status === 'pending_delivery' ? new Date(Date.now() + 28 * 864e5).toISOString().slice(0, 10) : null},
          ${status === 'reserved' ? new Date(Date.now() + 5 * 864e5).toISOString() : null},
          ${isDemo}
        )
        ON CONFLICT (tenant_id, stock_number) DO NOTHING
      `;
      written++;
    }
  }

  // A dealership can demonstrate everything it sells, so guarantee at least one
  // demonstrator per model. Leaving it to the random status mix meant some
  // models had none, and a customer asking to drive one was refused outright.
  await sql`
    UPDATE inventory_units u SET is_demo_vehicle = true, condition = 'demo', mileage_km = 1200
    WHERE u.tenant_id = ${tenantId}
      AND u.id IN (
        SELECT DISTINCT ON (m.id) u2.id
        FROM inventory_units u2
          JOIN model_configurations mc ON mc.id = u2.model_configuration_id
          JOIN vehicle_models m ON m.id = mc.model_id
        WHERE u2.tenant_id = ${tenantId}
          AND u2.status = 'available'
          AND NOT EXISTS (
            SELECT 1 FROM inventory_units d
              JOIN model_configurations dmc ON dmc.id = d.model_configuration_id
            WHERE dmc.model_id = m.id AND d.is_demo_vehicle
          )
        ORDER BY m.id, u2.stock_number
      )
  `;

  // Every demonstrator becomes a bookable resource. A test drive consumes the
  // car as well as the salesperson, so the car must exist as a resource for the
  // exclusion constraint to protect it.
  await sql`
    INSERT INTO resources (tenant_id, kind, name, inventory_unit_id)
    SELECT u.tenant_id, 'vehicle',
           m.full_name || ' ' || t.name || ' (' || u.stock_number || ')',
           u.id
    FROM inventory_units u
      JOIN model_configurations mc ON mc.id = u.model_configuration_id
      JOIN vehicle_models m ON m.id = mc.model_id
      JOIN trims t ON t.id = mc.trim_id
    WHERE u.tenant_id = ${tenantId} AND u.is_demo_vehicle
    ON CONFLICT DO NOTHING
  `;

  // Sales staff are bookable too.
  await sql`
    INSERT INTO resources (tenant_id, kind, name, staff_user_id)
    SELECT tenant_id, 'staff', full_name, id
    FROM staff_users
    WHERE tenant_id = ${tenantId} AND role = 'sales' AND status = 'active'
    ON CONFLICT DO NOTHING
  `;

  return written;
}
