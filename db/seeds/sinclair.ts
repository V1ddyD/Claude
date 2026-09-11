import type { Sql } from 'postgres';

/**
 * Sinclair — tenant #1 and the demonstration environment.
 *
 * This is SEED DATA, not configuration baked into the application. Everything
 * here is a row a second dealership would supply differently, which is the test
 * of whether the multi-tenant claim is real (M6 exit criterion).
 *
 * All people are fictional. Staff ids are fixed so the development auth adapter
 * and the demo scripts can reference them stably across resets.
 */

export const SINCLAIR_TENANT_ID = '5171c1a1-0000-4000-8000-000000000001';

export const SINCLAIR_STAFF = {
  admin: {
    id: '5171c1a1-57af-4000-8000-000000000001',
    email: 'dana.whitfield@sinclair.test',
    fullName: 'Dana Whitfield',
    role: 'admin' as const,
  },
  manager: {
    id: '5171c1a1-57af-4000-8000-000000000002',
    email: 'priya.raman@sinclair.test',
    fullName: 'Priya Raman',
    role: 'manager' as const,
  },
  sales: {
    id: '5171c1a1-57af-4000-8000-000000000003',
    email: 'marcus.hale@sinclair.test',
    fullName: 'Marcus Hale',
    role: 'sales' as const,
  },
  salesTwo: {
    id: '5171c1a1-57af-4000-8000-000000000004',
    email: 'elena.vossberg@sinclair.test',
    fullName: 'Elena Vossberg',
    role: 'sales' as const,
  },
  service: {
    id: '5171c1a1-57af-4000-8000-000000000005',
    email: 'tom.okafor@sinclair.test',
    fullName: 'Tom Okafor',
    role: 'service' as const,
  },
};

export async function seedSinclair(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO tenants (id, slug, legal_name, brand_name, timezone, currency, locale, ticket_prefix)
    VALUES (${SINCLAIR_TENANT_ID}, 'sinclair', 'Sinclair Motors Canada Inc.', 'Sinclair',
            'America/Toronto', 'CAD', 'en-CA', 'SIN')
    ON CONFLICT (id) DO UPDATE SET brand_name = EXCLUDED.brand_name
  `;

  await sql`
    INSERT INTO tenant_domains (tenant_id, hostname, is_primary) VALUES
      (${SINCLAIR_TENANT_ID}, 'sinclair.test', true),
      (${SINCLAIR_TENANT_ID}, 'localhost', false)
    ON CONFLICT (hostname) DO NOTHING
  `;

  await sql`
    INSERT INTO tenant_settings (tenant_id, contact, booking, lead, ai, email, finance)
    VALUES (
      ${SINCLAIR_TENANT_ID},
      ${sql.json({
        phone: '+1 416 555 0142',
        email: 'hello@sinclair.test',
        addressLine1: '1200 Lakeshore Boulevard West',
        city: 'Toronto', region: 'ON', postalCode: 'M6K 3B4', country: 'CA',
      })},
      ${sql.json({
        // Test drives: 45 minutes of driving plus 15 minutes of paperwork.
        slotMinutes: { test_drive: 60, consultation: 30, service: 60 },
        minNoticeHours: 2,
        maxHorizonDays: 14,
        responseSlaHours: { sales: 1, service: 4 },
      })},
      ${sql.json({
        // Band thresholds. Editable here rather than compiled into the scorer.
        bands: { high: 60, medium: 30 },
        autoAssign: 'round_robin',
        allowAiScoreAdjustment: false,
      })},
      ${sql.json({
        tone: 'Warm, precise, unhurried. Never pushy. Short sentences.',
        persona: 'Sinclair product specialist',
        monthlyTokenBudget: 20_000_000,
      })},
      ${sql.json({
        fromName: 'Sinclair',
        fromAddress: 'no-reply@sinclair.test',
        replyTo: 'hello@sinclair.test',
      })},
      ${sql.json({
        // An estimate input, never an offer. No taxes or fees are invented.
        defaultAprBps: 649,
        termsMonths: [36, 48, 60, 72, 84],
        disclaimer:
          'Estimate only. Excludes taxes, registration and dealer fees. ' +
          'Not an offer of credit or a guarantee of approval.',
      })}
    )
    ON CONFLICT (tenant_id) DO NOTHING
  `;

  // Mon-Fri 09:00-19:00, Sat 10:00-17:00, closed Sunday.
  await sql`
    INSERT INTO business_hours (tenant_id, department, day_of_week, opens_at, closes_at)
    SELECT ${SINCLAIR_TENANT_ID}, d.dept, d.dow::smallint, d.opens::time, d.closes::time
    FROM (VALUES
      ('sales',1,'09:00','19:00'), ('sales',2,'09:00','19:00'), ('sales',3,'09:00','19:00'),
      ('sales',4,'09:00','19:00'), ('sales',5,'09:00','19:00'), ('sales',6,'10:00','17:00'),
      ('service',1,'07:30','18:00'), ('service',2,'07:30','18:00'), ('service',3,'07:30','18:00'),
      ('service',4,'07:30','18:00'), ('service',5,'07:30','18:00')
    ) AS d(dept, dow, opens, closes)
    ON CONFLICT (tenant_id, department, day_of_week) DO NOTHING
  `;

  for (const staff of Object.values(SINCLAIR_STAFF)) {
    await sql`
      INSERT INTO staff_users (id, tenant_id, email, full_name, role, status)
      VALUES (${staff.id}, ${SINCLAIR_TENANT_ID}, ${staff.email}, ${staff.fullName},
              ${staff.role}, 'active')
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status
    `;
  }
}

/**
 * A second dealership, used only by the tenant isolation suite.
 *
 * It exists so isolation is asserted against a tenant that genuinely has data
 * of its own. Asserting that tenant B sees nothing is weak if tenant B has
 * nothing to see.
 */
export const NORTHWIND_TENANT_ID = '607e1a1d-0000-4000-8000-000000000002';

export async function seedSecondTenant(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO tenants (id, slug, legal_name, brand_name, ticket_prefix)
    VALUES (${NORTHWIND_TENANT_ID}, 'northwind', 'Northwind Automotive Group Ltd.',
            'Northwind', 'NWD')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO tenant_domains (tenant_id, hostname, is_primary)
    VALUES (${NORTHWIND_TENANT_ID}, 'northwind.test', true)
    ON CONFLICT (hostname) DO NOTHING
  `;
  await sql`
    INSERT INTO staff_users (id, tenant_id, email, full_name, role, status)
    VALUES ('607e1a1d-57af-4000-8000-000000000001', ${NORTHWIND_TENANT_ID},
            'ops@northwind.test', 'Northwind Operator', 'admin', 'active')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO customers (tenant_id, full_name, email, contact_consent)
    VALUES (${NORTHWIND_TENANT_ID}, 'Northwind Customer', 'customer@northwind.test', true)
    ON CONFLICT DO NOTHING
  `;
}
