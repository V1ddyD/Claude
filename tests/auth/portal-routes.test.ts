import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every portal route authorizes itself.
 *
 * Middleware redirects unauthenticated browsers, but it is not the boundary: it
 * can be bypassed and cannot express per-permission rules. So each page and
 * layout beneath /portal must call requireStaff (or withStaff, which calls it).
 *
 * This is a structural test rather than a behavioural one on purpose — it fails
 * the moment someone ADDS a route that forgets, which is exactly when the
 * mistake is cheap to fix and invisible to review.
 */

const PORTAL_DIR = 'src/app/(portal)';

/** Publicly reachable by necessity: you cannot sign in from behind a sign-in wall. */
const PUBLIC_ROUTES = ['portal/sign-in/page.tsx'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/^(page|layout|route)\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe('portal routes', () => {
  const files = walk(PORTAL_DIR);

  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('each call requireStaff, or are explicitly listed as public', () => {
    const unguarded: string[] = [];

    for (const file of files) {
      const relative = file.slice(PORTAL_DIR.length + 1);
      if (PUBLIC_ROUTES.includes(relative)) continue;

      const source = readFileSync(file, 'utf8');
      if (!/\b(requireStaff|withStaff)\b/.test(source)) unguarded.push(relative);
    }

    expect(
      unguarded,
      'these portal routes do not authorize themselves and rely on middleware alone',
    ).toEqual([]);
  });

  it('never take a tenant id from route params', () => {
    // A staff member's tenant comes from their own record. A route that accepted
    // one would let anyone operate on any dealership by editing the URL.
    const offenders = files.filter((file) =>
      /params.*\b(tenantId|tenant_id|tenantSlug)\b/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the dashboard', () => {
  /**
   * Signing in lands everyone on /portal. If that page demands one feature's
   * permission, the roles without it sign in successfully and are shown an
   * error — which is what happened to every manager, admin and service advisor
   * while the dashboard asked for `lead.read.assigned`.
   *
   * It must still authorize: being a member of staff is the requirement. What
   * it SHOWS is decided panel by panel with `staff.can`.
   */
  const source = readFileSync(join(PORTAL_DIR, 'portal/(dashboard)/page.tsx'), 'utf8');

  it('authorizes itself', () => {
    expect(/\b(requireStaff|withStaff)\b/.test(source)).toBe(true);
  });

  it('does not demand a feature permission to render', () => {
    const demanded = source.match(/withStaff\(\s*'([^']+)'/)?.[1];
    expect(
      demanded,
      `the landing page requires '${demanded}', so roles without it get an error page`,
    ).toBeUndefined();
  });

  it('decides its lead panels by capability instead', () => {
    expect(source).toMatch(/can\('lead\.read\.assigned'\)/);
  });
});

describe('the sign-in route', () => {
  it('is the only public portal route', () => {
    const publicish = walk(PORTAL_DIR).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return !/\b(requireStaff|withStaff)\b/.test(source);
    });
    expect(publicish.map((f) => f.slice(PORTAL_DIR.length + 1)).sort()).toEqual(
      [...PUBLIC_ROUTES].sort(),
    );
  });
});
