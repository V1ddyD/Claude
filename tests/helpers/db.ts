import postgres, { type Sql } from 'postgres';
import { migrate } from '../../src/server/db/migrate';
import { seedSinclair, seedSecondTenant, SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { SINCLAIR_CATALOGUE } from '../../db/seeds/catalogue';
import { writeModel } from '../../db/seeds/catalogue-writer';
import { seedInventory } from '../../db/seeds/inventory';

/**
 * Test database harness.
 *
 * Two connections with deliberately different privileges, mirroring production:
 *
 *   admin   — owner role. Migrations, seeding, and setting up fixtures.
 *   appUser — the unprivileged request-path role, subject to RLS.
 *
 * The isolation suite is only meaningful when run as `appUser`: asserting that
 * an owner connection is isolated would prove nothing, because FORCE ROW LEVEL
 * SECURITY is the only reason it would be, and a future migration could drop it.
 */

export const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  (() => {
    throw new Error(
      'DATABASE_ADMIN_URL is not set. Start a test database first:\n' +
        '  eval "$(./scripts/test-db.sh start)"',
    );
  })();

export const APP_URL = process.env.DATABASE_URL ?? ADMIN_URL;

let prepared = false;

export async function prepareDatabase(): Promise<void> {
  if (prepared) return;
  await migrate(ADMIN_URL, { quiet: true });

  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`SET row_security = off`;

    // Seed only once per database. Catalogue children (features, availability)
    // are additive, so re-running would double them and quietly change counts
    // the assertions depend on.
    const [existing] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM vehicle_models WHERE tenant_id = ${SINCLAIR_TENANT_ID}
    `;

    await seedSinclair(sql);
    await seedSecondTenant(sql);

    if (existing!.count === 0) {
      for (const model of SINCLAIR_CATALOGUE) {
        await writeModel(sql, SINCLAIR_TENANT_ID, model);
      }
      await seedInventory(sql, SINCLAIR_TENANT_ID);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  prepared = true;
}

export function adminConnection(): Sql {
  return postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
}

export function appConnection(): Sql {
  return postgres(APP_URL, { max: 2, onnotice: () => {} });
}

/** Runs a callback inside a tenant-scoped transaction, as the app role. */
export async function asTenant<T>(
  sql: Sql,
  tenantId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

/** Runs a callback with an auth subject but no tenant context. */
export async function asAuthSubject<T>(
  sql: Sql,
  authUserId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.auth_user_id', ${authUserId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}
