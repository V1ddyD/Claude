import postgres from 'postgres';
import { loadEnvFile } from '../../src/server/config/load-env-file';
import { seedSinclair, seedSecondTenant, SINCLAIR_TENANT_ID } from './sinclair';
import { SINCLAIR_CATALOGUE } from './catalogue';
import { writeModel } from './catalogue-writer';
import { seedInventory } from './inventory';

/**
 * Seeds run as the OWNER role. RLS is FORCEd on tenant tables, so a seed run
 * through the request-path role would insert nothing and report success —
 * which is exactly the kind of silent failure the FORCE is there to prevent.
 */
async function main() {
  loadEnvFile();
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL (or DATABASE_URL) must be set');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Seeding writes tenant rows directly and must bypass the tenant GUC, which
    // is not yet set for a tenant that does not exist.
    await sql`SET row_security = off`;
    await seedSinclair(sql);

    for (const model of SINCLAIR_CATALOGUE) {
      await writeModel(sql, SINCLAIR_TENANT_ID, model);
    }
    const units = await seedInventory(sql, SINCLAIR_TENANT_ID);

    if (process.env.SEED_SECOND_TENANT === 'true' || process.env.NODE_ENV === 'test') {
      await seedSecondTenant(sql);
    }

    const [counts] = await sql`
      SELECT (SELECT count(*) FROM vehicle_models WHERE tenant_id = ${SINCLAIR_TENANT_ID}) AS models,
             (SELECT count(*) FROM model_configurations WHERE tenant_id = ${SINCLAIR_TENANT_ID}) AS configurations,
             (SELECT count(*) FROM options WHERE tenant_id = ${SINCLAIR_TENANT_ID}) AS options
    `;
    console.log(
      `Seeded Sinclair: ${counts!.models} models, ${counts!.configurations} configurations, ` +
        `${counts!.options} options, ${units} inventory units.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
