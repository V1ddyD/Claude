import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { withTenant, withoutTenantScope } from '@/server/db/tenant-db';
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

  const tenant = await withoutTenantScope('tenant-resolution', async (db) => {
    const byDomain = await db
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
      .from(tenantDomains)
      .innerJoin(tenants, eq(tenants.id, tenantDomains.tenantId))
      .where(eq(tenantDomains.hostname, hostname))
      .limit(1);

    if (byDomain[0]) return byDomain[0];

    // Development convenience only: localhost and preview URLs are not
    // registered domains. Refused in production, where an unrecognised host
    // must not silently serve some default dealership's data.
    if (env.NODE_ENV === 'production') return undefined;

    const fallback = await db
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
      .where(eq(tenants.slug, env.DEFAULT_TENANT_SLUG))
      .limit(1);

    return fallback[0];
  });

  if (!tenant) {
    throw new AppError('TENANT_NOT_RESOLVED', 'This site is not available.', {
      internal: { hostname },
    });
  }
  if (tenant.status !== 'active') {
    throw new AppError('TENANT_NOT_RESOLVED', 'This site is not available.', {
      internal: { hostname, status: tenant.status },
    });
  }

  const { status: _status, ...resolved } = tenant;
  cache.set(hostname, { tenant: resolved, expires: Date.now() + TTL_MS });
  return resolved;
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
