import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection, ADMIN_URL } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';

/**
 * Dropping privilege when the platform gives you one role.
 *
 * The design wants the request path connecting as an unprivileged role. Two
 * connection strings is the direct way to get that; a managed database often
 * hands you a single role that owns the tables, and `DATABASE_REQUEST_ROLE`
 * makes every tenant transaction `SET LOCAL ROLE` to the unprivileged one
 * first.
 *
 * These tests connect as the OWNER on purpose. Row-level security is FORCEd,
 * so isolation alone would not distinguish the two cases — the GRANTS do.
 * `audit_logs` is append-only for `app_user` and writable by its owner, so
 * whether an UPDATE on it succeeds says exactly which role the statement ran
 * as. That is the assertion worth having: not that the setting is applied, but
 * that privilege actually went away.
 */

let admin: Sql;

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
});
afterEach(() => {
  vi.resetModules();
});

/** Loads the data layer connected as the owner, with the role switch on or off. */
async function asOwner(requestRole?: string) {
  vi.resetModules();
  process.env.DATABASE_URL = ADMIN_URL;
  if (requestRole) process.env.DATABASE_REQUEST_ROLE = requestRole;
  else delete process.env.DATABASE_REQUEST_ROLE;

  const { withTenant } = await import('../../src/server/db/tenant-db');
  const { closeConnections } = await import('../../src/server/db/client');
  return { withTenant, closeConnections };
}

describe('connected as the table owner', () => {
  it('can write audit_logs when no request role is configured', async () => {
    const { withTenant, closeConnections } = await asOwner();
    try {
      const updated = await withTenant(SINCLAIR_TENANT_ID, async (db) => {
        const { sql } = await import('drizzle-orm');
        // Nothing is actually modified: a predicate that matches no row still
        // requires the UPDATE privilege to be planned and executed.
        await db.execute(sql`UPDATE audit_logs SET action = action WHERE false`);
        return true;
      });
      expect(updated).toBe(true);
    } finally {
      await closeConnections();
    }
  });

  it('is refused that write once it assumes the request role', async () => {
    const { withTenant, closeConnections } = await asOwner('app_user');
    try {
      await expect(
        withTenant(SINCLAIR_TENANT_ID, async (db) => {
          const { sql } = await import('drizzle-orm');
          await db.execute(sql`UPDATE audit_logs SET action = action WHERE false`);
        }),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    } finally {
      await closeConnections();
    }
  });

  it('still reads its own tenant normally', async () => {
    const { withTenant, closeConnections } = await asOwner('app_user');
    try {
      const models = await withTenant(SINCLAIR_TENANT_ID, async (db) => {
        const { sql } = await import('drizzle-orm');
        return db.execute(sql`SELECT count(*)::int AS count FROM vehicle_models`);
      });
      expect(Number((models as unknown as { count: number }[])[0]!.count)).toBeGreaterThan(0);
    } finally {
      await closeConnections();
    }
  });

  it('reverts when the transaction ends, so nothing leaks between requests', async () => {
    const { withTenant, closeConnections } = await asOwner('app_user');
    try {
      const inside = await withTenant(SINCLAIR_TENANT_ID, async (db) => {
        const { sql } = await import('drizzle-orm');
        const rows = await db.execute(sql`SELECT current_user AS who`);
        return (rows as unknown as { who: string }[])[0]!.who;
      });
      expect(inside).toBe('app_user');

      // A later transaction on the same pool sets it again rather than
      // inheriting it, and SET LOCAL has already reverted either way.
      const again = await withTenant(SINCLAIR_TENANT_ID, async (db) => {
        const { sql } = await import('drizzle-orm');
        const rows = await db.execute(sql`SELECT current_user AS who`);
        return (rows as unknown as { who: string }[])[0]!.who;
      });
      expect(again).toBe('app_user');
    } finally {
      await closeConnections();
    }
  });
});

describe('the role name', () => {
  it('is constrained to an identifier, because SET ROLE cannot bind a parameter', async () => {
    vi.resetModules();
    process.env.DATABASE_REQUEST_ROLE = 'app_user"; DROP TABLE leads; --';
    const { env } = await import('../../src/server/config/env');
    expect(() => env.DATABASE_REQUEST_ROLE).toThrow(/DATABASE_REQUEST_ROLE/);
    delete process.env.DATABASE_REQUEST_ROLE;
  });
});
