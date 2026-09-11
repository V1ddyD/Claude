import postgres from 'postgres';
import { loadEnvFile } from '../../src/server/config/load-env-file';

/**
 * Truncates every tenant-owned table so `db:seed` starts clean.
 *
 * Refuses to run against anything that looks like production. Seeds are
 * idempotent by upsert, but catalogue children (features, availability) are
 * additive, so a reset is the honest way to re-seed.
 */
async function main() {
  loadEnvFile();
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL (or DATABASE_URL) must be set');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset refuses to run with NODE_ENV=production');
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`SET row_security = off`;
    const tables = await sql<{ name: string }[]>`
      SELECT c.relname AS name
      FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    `;
    const names = [...tables.map((t) => t.name), 'tenants'];
    await sql.unsafe(`TRUNCATE ${names.map((n) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`);
    console.log(`Truncated ${names.length} tables.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
