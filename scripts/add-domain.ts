/**
 * Point a hostname at a dealership.
 *
 *   npm run domain:add -- sinclair-demo.netlify.app
 *   npm run domain:add -- cars.example.com sinclair
 *
 * Why this exists: in production an unregistered hostname deliberately serves
 * nothing. `tenant_domains` is how the platform knows which dealership a
 * request belongs to, and falling back to "whichever one is configured by
 * default" would mean a typo in DNS quietly serving one dealership's data
 * under another's address. So a deployment on a new hostname — a Netlify
 * subdomain, a custom domain — registers it once, here.
 */
import postgres from 'postgres';
import { loadEnvFile } from '../src/server/config/load-env-file';

async function main() {
  loadEnvFile();

  const [hostname, slug = process.env.DEFAULT_TENANT_SLUG ?? 'sinclair'] = process.argv.slice(2);
  if (!hostname) {
    console.error('Usage: npm run domain:add -- <hostname> [tenant-slug]');
    process.exit(1);
  }

  const normalised = hostname.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+$/.test(normalised)) {
    console.error(`"${hostname}" does not look like a hostname.`);
    process.exit(1);
  }

  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL (or DATABASE_URL) must be set');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`SET row_security = off`;

    const [tenant] = await sql<{ id: string; brand_name: string }[]>`
      SELECT id, brand_name FROM tenants WHERE slug = ${slug}
    `;
    if (!tenant) {
      console.error(`No dealership with slug "${slug}". Run \`npm run db:seed\` first.`);
      process.exit(1);
    }

    // A hostname maps to exactly one dealership, so a collision belonging to
    // someone else is a real conflict rather than something to overwrite.
    const [clash] = await sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM tenant_domains WHERE hostname = ${normalised}
    `;
    if (clash && clash.tenant_id !== tenant.id) {
      console.error(`"${normalised}" already belongs to another dealership.`);
      process.exit(1);
    }

    await sql`
      INSERT INTO tenant_domains (tenant_id, hostname, is_primary)
      VALUES (${tenant.id}, ${normalised}, false)
      ON CONFLICT (hostname) DO NOTHING
    `;

    console.log(`${normalised} now serves ${tenant.brand_name}.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
