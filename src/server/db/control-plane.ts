import 'server-only';
import postgres from 'postgres';
import { env, isProduction } from '@/server/config/env';

/**
 * Control-plane reads.
 *
 * Enumerating tenants is not something the request path may do — RLS is FORCEd
 * on `tenants`, so neither the application role nor the owner can list them
 * without a context. That is deliberate: the tenant list is not data any
 * request should be able to reach.
 *
 * The background worker genuinely needs it, because "iterate every dealership"
 * is its job (docs/00-architecture.md §2). So it is done here, through the
 * owner connection, returning IDS ONLY — and every piece of actual work the
 * worker then performs goes through `withTenant`, as the application role,
 * under RLS.
 *
 * If this module ever returns anything but tenant identifiers, that is a bug.
 */
/**
 * Development fallback: map a tenant slug to an id.
 *
 * Needed because localhost and preview URLs are not registered domains. Refused
 * in production, where an unknown hostname is a misconfiguration rather than
 * something to guess around.
 */
export async function devTenantIdBySlug(slug: string): Promise<string | null> {
  if (isProduction) return null;

  const url = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`SET row_security = off`;
    const rows = await sql<{ id: string }[]>`SELECT id FROM tenants WHERE slug = ${slug} LIMIT 1`;
    return rows[0]?.id ?? null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function listActiveTenantIds(): Promise<string[]> {
  const url = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await sql`SET row_security = off`;
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM tenants WHERE status = 'active' ORDER BY created_at
    `;
    return rows.map((row) => row.id);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
