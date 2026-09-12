import 'server-only';
import postgres from 'postgres';
import { env, isProduction, features } from '@/server/config/env';

/**
 * Development staff directory.
 *
 * Listing staff accounts is a privileged directory operation — the sort a real
 * identity provider performs, not the sort a request-path role may. RLS on
 * `staff_users` deliberately blocks it: the `staff_self` policy returns only
 * the caller's own row, so the application role cannot enumerate a dealership's
 * employees even in its own tenant.
 *
 * That is correct, and it is why this module exists separately and uses the
 * OWNER connection. It stands in for Supabase's user directory, which occupies
 * exactly the same privileged position in production.
 *
 * Refuses to run in production, and refuses to run when a real identity
 * provider is configured, so it cannot become a way to read the staff table.
 */
export interface DevAccount {
  id: string;
  fullName: string;
  email: string;
  role: string;
  tenantSlug: string;
}

function assertDevOnly(): void {
  // A demonstration deployment is the one production-ish case allowed here,
  // and only because the sign-in page will not call this until the demo
  // password has been supplied.
  if (isProduction && !features.demoPortal) {
    throw new Error('The development staff directory is not available in production.');
  }
  if (features.supabaseAuth) {
    throw new Error(
      'A real identity provider is configured; the development staff directory is disabled.',
    );
  }
}

export async function listDevAccounts(): Promise<DevAccount[]> {
  assertDevOnly();
  const url = env.DATABASE_ADMIN_URL;
  if (!url) return [];

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await sql<DevAccount[]>`
      SELECT s.id, s.full_name AS "fullName", s.email, s.role, t.slug AS "tenantSlug"
      FROM staff_users s
        JOIN tenants t ON t.id = s.tenant_id
      WHERE s.status = 'active'
      ORDER BY t.slug, s.role, s.full_name
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Re-reads one account server-side. The posted id is untrusted input. */
export async function findDevAccount(id: string): Promise<DevAccount | null> {
  assertDevOnly();
  const url = env.DATABASE_ADMIN_URL;
  if (!url) return null;

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<DevAccount[]>`
      SELECT s.id, s.full_name AS "fullName", s.email, s.role, t.slug AS "tenantSlug"
      FROM staff_users s
        JOIN tenants t ON t.id = s.tenant_id
      WHERE s.id = ${id} AND s.status = 'active'
      LIMIT 1
    `;
    return rows[0] ?? null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
