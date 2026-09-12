import 'server-only';
import postgres from 'postgres';
import { migrate } from '@/server/db/migrate';
import { EMBEDDED_MIGRATIONS } from '@/server/db/migrations.generated';
import { env } from '@/server/config/env';
import { DEMONSTRATION_SEED_SQL, SEED_ROW_COUNT } from '@/server/db/seed.generated';
import { SINCLAIR_TENANT_ID } from '../../../../db/seeds/sinclair';

/**
 * Bringing a hosted demonstration database up from empty.
 *
 * A managed database can be unreachable from anywhere but the application:
 * no connection string is exposed outside the platform's own build, so there
 * is nowhere else to run migrations from. This is that place.
 *
 * It owns its own connection deliberately, which is why this module is named
 * in the lint rule that otherwise forbids that. Migrations create roles and
 * policies and seeding writes tenant rows before any tenant exists — neither
 * is possible through `withTenant`, and both must run as the owner rather than
 * the request role.
 *
 * Idempotent: migrations are tracked in `schema_migrations`, the dealership
 * seed is upserted, and the catalogue is written only when there is none.
 */

export interface BootstrapReport {
  models: number;
  inventoryUnits: number;
  /** True when the dealership was written by this call. */
  seededNow: boolean;
  host: string | null;
}

/**
 * The owner connection.
 *
 * `DATABASE_ADMIN_URL` where one is configured; otherwise the single
 * credential a managed platform provides, which owns the tables.
 */
function ownerUrl(): string | undefined {
  return env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
}

/** Every model in the catalogue this seed carries. */
const EXPECTED_MODELS = (DEMONSTRATION_SEED_SQL.match(/^INSERT INTO public\.vehicle_models /gm) ?? [])
  .length;

export async function bootstrapDemonstration(
  options: { hostname?: string } = {},
): Promise<BootstrapReport> {
  const url = ownerUrl();
  if (!url) throw new Error('No database is configured.');

  // The compiled-in copy: a serverless function's working directory is not the
  // repository, so the SQL cannot be read from disk here.
  await migrate(url, { quiet: true, migrations: EMBEDDED_MIGRATIONS });

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Seeding writes tenant rows directly and must bypass the tenant GUC,
    // which is not set for a tenant that does not exist yet.
    await sql`SET row_security = off`;

    const [before] = await sql<{ models: number; units: number }[]>`
      SELECT (SELECT count(*)::int FROM vehicle_models WHERE tenant_id = ${SINCLAIR_TENANT_ID}) AS models,
             (SELECT count(*)::int FROM inventory_units WHERE tenant_id = ${SINCLAIR_TENANT_ID}) AS units
    `;

    const complete = before!.models >= EXPECTED_MODELS && before!.units > 0;
    let seededNow = false;

    if (!complete) {
      // An incomplete catalogue is replaced rather than topped up. A half
      // written dealership — a model with no configurations, a configuration
      // with no stock — is worse than none: pages half render and the
      // assistant offers cars it cannot price.
      //
      // Only reachable while the demonstration is incomplete, so a later call
      // never discards enquiries that visitors have since left.
      await sql.unsafe(`
        TRUNCATE TABLE tenants CASCADE;
        ${DEMONSTRATION_SEED_SQL}
      `);
      seededNow = true;
    }

    // The last thing a deployment needs: an unregistered hostname
    // deliberately serves no dealership at all.
    const host = options.hostname?.toLowerCase().split(':')[0] ?? null;
    if (host) {
      await sql`
        INSERT INTO tenant_domains (tenant_id, hostname, is_primary)
        VALUES (${SINCLAIR_TENANT_ID}, ${host}, false)
        ON CONFLICT (hostname) DO NOTHING
      `;
    }

    const [counts] = await sql<{ models: number; units: number }[]>`
      SELECT (SELECT count(*)::int FROM vehicle_models WHERE tenant_id = ${SINCLAIR_TENANT_ID}) AS models,
             (SELECT count(*)::int FROM inventory_units WHERE tenant_id = ${SINCLAIR_TENANT_ID}) AS units
    `;

    if (counts!.models < EXPECTED_MODELS) {
      throw new Error(
        `Seed incomplete: ${counts!.models} of ${EXPECTED_MODELS} models, ` +
          `${SEED_ROW_COUNT} rows expected.`,
      );
    }

    return { models: counts!.models, inventoryUnits: counts!.units, seededNow, host };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
