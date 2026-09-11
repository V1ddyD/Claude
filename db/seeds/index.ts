import postgres from 'postgres';
import { seedSinclair, seedSecondTenant } from './sinclair';

/**
 * Seeds run as the OWNER role. RLS is FORCEd on tenant tables, so a seed run
 * through the request-path role would insert nothing and report success —
 * which is exactly the kind of silent failure the FORCE is there to prevent.
 */
async function main() {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL (or DATABASE_URL) must be set');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Seeding writes tenant rows directly and must bypass the tenant GUC, which
    // is not yet set for a tenant that does not exist.
    await sql`SET row_security = off`;
    await seedSinclair(sql);
    if (process.env.SEED_SECOND_TENANT === 'true' || process.env.NODE_ENV === 'test') {
      await seedSecondTenant(sql);
    }
    console.log('Seeded Sinclair.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
