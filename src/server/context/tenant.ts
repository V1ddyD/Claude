import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { withTenant, withoutTenantScope } from '@/server/db/tenant-db';
import { devTenantIdBySlug } from '@/server/db/control-plane';
import { tenantDomains, tenants } from '@/server/db/schema';
import { AppError } from '@/server/errors';
import { env } from '@/server/config/env';

export interface ResolvedTenant {
  id: string;
  slug: string;
  brandName: string;
  legalName: string;
  timezone: string;
  currency: string;
  locale: string;
  ticketPrefix: string;
}

/**
 * Resolve which dealership a request belongs to.
 *
 * For the customer site this comes from the hostname, and for the portal from
 * the signed-in staff member's own record. Neither is ever taken from a query
 * parameter, a header the client controls, or a path segment — accepting a
 * client-supplied tenant id is the whole attack against a multi-tenant system.
 */

const cache = new Map<string, { tenant: ResolvedTenant; expires: number }>();
const TTL_MS = 60_000;

function normaliseHost(host: string): string {
  return host.toLowerCase().split(':')[0] ?? '';
}

export async function resolveTenantByHost(host: string | null): Promise<ResolvedTenant> {
  const hostname = normaliseHost(host ?? '');

  const cached = cache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.tenant;

  // Two steps, and it has to be two.
  //
  // `tenant_domains` is readable without a context — it is the one table that
  // must be, because resolution happens BEFORE a tenant is known, and it holds
  // nothing but a hostname and the id it maps to. `tenants` is not: it is
  // scoped to the caller's own row. So the hostname gives us an id, and the id
  // gives us a context in which the tenant row is readable.
  //
  // Joining the two in one query looks obvious and silently returns nothing.
  const tenantId = await resolveTenantIdForHost(hostname);
  if (!tenantId) {
    throw new AppError('TENANT_NOT_RESOLVED', 'This site is not available.', {
      internal: { hostname },
    });
  }

  const tenant = await withTenant(tenantId, async (db) => {
    const rows = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        brandName: tenants.brandName,
        legalName: tenants.legalName,
        timezone: tenants.timezone,
        currency: tenants.currency,
        locale: tenants.locale,
        ticketPrefix: tenants.ticketPrefix,
        status: tenants.status,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return rows[0];
  });

  if (!tenant || tenant.status !== 'active') {
    throw new AppError('TENANT_NOT_RESOLVED', 'This site is not available.', {
      internal: { hostname, status: tenant?.status },
    });
  }

  const { status: _status, ...resolved } = tenant;
  cache.set(hostname, { tenant: resolved, expires: Date.now() + TTL_MS });
  return resolved;
}

async function resolveTenantIdForHost(hostname: string): Promise<string | null> {
  const byDomain = await withoutTenantScope('tenant-resolution', (db) =>
    db
      .select({ tenantId: tenantDomains.tenantId })
      .from(tenantDomains)
      .where(eq(tenantDomains.hostname, hostname))
      .limit(1),
  );

  if (byDomain[0]) return byDomain[0].tenantId;

  // Development only. In production an unregistered hostname must not quietly
  // serve some default dealership's data — it is a misconfiguration, and
  // guessing hides it.
  if (env.NODE_ENV === 'production') return null;

  return devTenantIdBySlug(env.DEFAULT_TENANT_SLUG);
}

/**
 * Look up the tenant a signed-in staff member belongs to.
 *
 * Reads the tenant's own row through the tenant-scoped policy, so it can only
 * ever return the caller's own dealership.
 */
export async function getTenantById(tenantId: string): Promise<ResolvedTenant> {
  const rows = await withTenant(tenantId, (db) =>
    db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        brandName: tenants.brandName,
        legalName: tenants.legalName,
        timezone: tenants.timezone,
        currency: tenants.currency,
        locale: tenants.locale,
        ticketPrefix: tenants.ticketPrefix,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1),
  );
  const tenant = rows[0];
  if (!tenant) {
    throw new AppError('TENANT_NOT_RESOLVED', 'This site is not available.', {
      internal: { tenantId },
    });
  }
  return tenant;
}

/** Clears the resolution cache. Used by tests and by tenant settings writes. */
export function invalidateTenantCache(hostname?: string): void {
  if (hostname) cache.delete(normaliseHost(hostname));
  else cache.clear();
}

/** Reads the tenant id RLS is currently enforcing. Used by the isolation tests. */
export async function currentTenantIdInSession(
  db: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
): Promise<string | null> {
  const rows = (await db.execute(
    sql`select app.current_tenant_id() as id`,
  )) as unknown as Array<{ id: string | null }>;
  return rows[0]?.id ?? null;
}
