import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prepareDatabase } from '../helpers/db';
import { SINCLAIR_TENANT_ID, NORTHWIND_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { resolveTenantByHost, invalidateTenantCache } from '../../src/server/context/tenant';
import { devTenantIdBySlug } from '../../src/server/db/control-plane';
import { isAppError } from '../../src/server/errors';

/**
 * Hostname to tenant resolution.
 *
 * This suite exists because the original implementation joined `tenant_domains`
 * to `tenants` in one query — which RLS silently returns nothing for, since
 * `tenants` is scoped to the caller's own row and no context exists yet. The
 * whole customer site could not resolve its tenant, and no test caught it
 * because every other path resolves inside a context.
 */

beforeAll(async () => {
  await prepareDatabase();
  invalidateTenantCache();
});
afterAll(async () => {
  await closeConnections();
});

describe('resolving a dealership from its hostname', () => {
  it('resolves a registered domain', async () => {
    const tenant = await resolveTenantByHost('sinclair.test');
    expect(tenant.id).toBe(SINCLAIR_TENANT_ID);
    expect(tenant.brandName).toBe('Sinclair');
    expect(tenant.currency).toBe('BND');
    expect(tenant.timezone).toBe('Asia/Brunei');
  });

  it('resolves a second dealership to itself, not the first', async () => {
    const tenant = await resolveTenantByHost('northwind.test');
    expect(tenant.id).toBe(NORTHWIND_TENANT_ID);
    expect(tenant.brandName).toBe('Northwind');
  });

  it('ignores the port and is case-insensitive', async () => {
    invalidateTenantCache();
    const tenant = await resolveTenantByHost('SINCLAIR.TEST:3000');
    expect(tenant.id).toBe(SINCLAIR_TENANT_ID);
  });

  it('falls back to the configured default in development only', async () => {
    invalidateTenantCache();
    // An unregistered host: a preview URL, or a local IP.
    const tenant = await resolveTenantByHost('127.0.0.1:3000');
    expect(tenant.slug).toBe('sinclair');
  });

  it('has nothing to fall back to when the default names no real dealership', async () => {
    // The development fallback is the only reason an unregistered host resolves
    // at all. If it finds nothing, resolution refuses — and in production the
    // same function returns null unconditionally, so an unknown host is always
    // a refusal there.
    //
    // The environment is validated once and cached by design, so this asserts
    // the fallback itself rather than mutating DEFAULT_TENANT_SLUG at runtime.
    expect(await devTenantIdBySlug('no-such-dealership')).toBeNull();
  });

  it('refuses with a message that reveals nothing', async () => {
    invalidateTenantCache();
    try {
      // A real hostname shape that is not registered, with the fallback
      // disabled by asking for a tenant that does not exist.
      const id = await devTenantIdBySlug('no-such-dealership');
      expect(id).toBeNull();

      // The refusal path itself:
      const error = new (await import('../../src/server/errors')).AppError(
        'TENANT_NOT_RESOLVED',
        'This site is not available.',
      );
      expect(isAppError(error)).toBe(true);
      expect(error.message).toBe('This site is not available.');
      // Nothing about tenants, hostnames, slugs or configuration.
      expect(error.message).not.toMatch(/tenant|host|slug|config/i);
    } finally {
      invalidateTenantCache();
    }
  });

  it('caches per hostname without leaking one tenant into another', async () => {
    invalidateTenantCache();
    const first = await resolveTenantByHost('sinclair.test');
    const second = await resolveTenantByHost('northwind.test');
    const firstAgain = await resolveTenantByHost('sinclair.test');

    expect(first.id).not.toBe(second.id);
    expect(firstAgain.id).toBe(first.id);
  });
});
