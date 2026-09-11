import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import {
  prepareDatabase, adminConnection, appConnection, asTenant, asAuthSubject,
} from '../helpers/db';
import { SINCLAIR_TENANT_ID, SINCLAIR_STAFF, NORTHWIND_TENANT_ID } from '../../db/seeds/sinclair';

/**
 * Tenant isolation.
 *
 * This suite is non-skippable and gates every deploy. It runs as the
 * unprivileged request-path role, so it proves the DATABASE enforces isolation
 * independently of whether the application layer scoped its queries — which is
 * the whole point of having both.
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

describe('the request-path role', () => {
  it('is not superuser and does not bypass RLS', async () => {
    const [row] = await admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `.then(() => app<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `);
    // If either were true, every other assertion in this file would pass
    // vacuously while providing no protection at all.
    expect(row?.rolsuper).toBe(false);
    expect(row?.rolbypassrls).toBe(false);
  });

  it('is not the owner of the tables it queries', async () => {
    const [row] = await app<{ owned: number }[]>`
      SELECT count(*)::int AS owned
      FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND pg_get_userbyid(c.relowner) = current_user
    `;
    expect(row?.owned).toBe(0);
  });
});

describe('every tenant-scoped table', () => {
  it('has RLS enabled, forced, and a policy — with no exceptions', async () => {
    const rows = await admin<
      { table_name: string; enabled: boolean; forced: boolean; policies: number }[]
    >`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `;

    // A new table added by a later migration without a policy fails here,
    // rather than leaking silently until someone notices.
    expect(rows.length).toBeGreaterThan(40);
    const bad = rows.filter((r) => !r.enabled || !r.forced || r.policies === 0);
    expect(bad.map((r) => r.table_name)).toEqual([]);
  });
});

describe('reads', () => {
  it('returns only the tenant in context', async () => {
    const rows = await asTenant(app, SINCLAIR_TENANT_ID, (tx) =>
      tx<{ tenant_id: string }[]>`SELECT tenant_id FROM staff_users`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === SINCLAIR_TENANT_ID)).toBe(true);
  });

  it('returns zero rows of another tenant, which genuinely has rows', async () => {
    // The other tenant really does have staff and customers; asserting
    // emptiness against an empty tenant would prove nothing.
    const seeded = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM staff_users WHERE tenant_id = ${NORTHWIND_TENANT_ID}
    `;
    expect(seeded[0]?.count).toBeGreaterThan(0);

    const visible = await asTenant(app, SINCLAIR_TENANT_ID, (tx) =>
      tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM staff_users WHERE tenant_id = ${NORTHWIND_TENANT_ID}
      `,
    );
    expect(visible[0]?.count).toBe(0);
  });

  it('fails closed when no tenant context is set', async () => {
    // The dangerous failure mode is a forgotten context returning EVERYTHING.
    for (const table of ['staff_users', 'customers', 'leads', 'appointments', 'tickets']) {
      const [row] = await app<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ${app(table)}
      `;
      expect.soft(row?.count, `${table} leaked rows with no tenant context`).toBe(0);
    }
  });

  it('fails closed for a tenant id that does not exist', async () => {
    const rows = await asTenant(app, '00000000-0000-4000-8000-00000000dead', (tx) =>
      tx<{ count: number }[]>`SELECT count(*)::int AS count FROM staff_users`,
    );
    expect(rows[0]?.count).toBe(0);
  });
});

describe('writes', () => {
  it('rejects inserting a row carrying another tenant id', async () => {
    await expect(
      asTenant(app, NORTHWIND_TENANT_ID, (tx) =>
        tx`INSERT INTO customers (tenant_id, full_name) VALUES (${SINCLAIR_TENANT_ID}, 'Injected')`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot update another tenant rows even by primary key', async () => {
    const [victim] = await admin<{ id: string }[]>`
      SELECT id FROM staff_users WHERE tenant_id = ${SINCLAIR_TENANT_ID} LIMIT 1
    `;
    const result = await asTenant(app, NORTHWIND_TENANT_ID, (tx) =>
      tx`UPDATE staff_users SET full_name = 'Tampered' WHERE id = ${victim!.id}`,
    );
    expect(result.count).toBe(0);

    const [after] = await admin<{ full_name: string }[]>`
      SELECT full_name FROM staff_users WHERE id = ${victim!.id}
    `;
    expect(after?.full_name).not.toBe('Tampered');
  });

  it('cannot delete another tenant rows', async () => {
    const before = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM customers WHERE tenant_id = ${SINCLAIR_TENANT_ID}
    `;
    await asTenant(app, NORTHWIND_TENANT_ID, (tx) =>
      tx`DELETE FROM customers WHERE tenant_id = ${SINCLAIR_TENANT_ID}`,
    );
    const after = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM customers WHERE tenant_id = ${SINCLAIR_TENANT_ID}
    `;
    expect(after[0]?.count).toBe(before[0]?.count);
  });
});

describe('staff sign-in lookup', () => {
  it('returns the authenticated subject own row before any tenant is known', async () => {
    const rows = await asAuthSubject(app, SINCLAIR_STAFF.sales.id, (tx) =>
      tx<{ id: string; tenant_id: string }[]>`
        SELECT id, tenant_id FROM staff_users WHERE id = ${SINCLAIR_STAFF.sales.id}
      `,
    );
    expect(rows[0]?.tenant_id).toBe(SINCLAIR_TENANT_ID);
  });

  it('cannot be used to enumerate other staff', async () => {
    const rows = await asAuthSubject(app, SINCLAIR_STAFF.sales.id, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM staff_users`,
    );
    // Exactly one row: the caller's own. Not the tenant's whole staff list.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(SINCLAIR_STAFF.sales.id);
  });
});

describe('audit log', () => {
  it('accepts inserts', async () => {
    await expect(
      asTenant(app, SINCLAIR_TENANT_ID, (tx) =>
        tx`INSERT INTO audit_logs (tenant_id, actor_type, action, entity_type)
           VALUES (${SINCLAIR_TENANT_ID}, 'system', 'test.written', 'test')`,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses updates and deletes, so history cannot be rewritten', async () => {
    await expect(
      asTenant(app, SINCLAIR_TENANT_ID, (tx) => tx`UPDATE audit_logs SET action = 'tampered'`),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      asTenant(app, SINCLAIR_TENANT_ID, (tx) => tx`DELETE FROM audit_logs`),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('reference data', () => {
  it('is readable without a tenant context but not writable', async () => {
    const [row] = await app<{ count: number }[]>`
      SELECT count(*)::int AS count FROM role_permissions
    `;
    expect(row?.count).toBeGreaterThan(0);

    await expect(
      app`INSERT INTO role_permissions (role, permission) VALUES ('sales','settings.write')`,
    ).rejects.toMatchObject({ code: '42501' });
  });
});
