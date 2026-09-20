import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Which deployments migrate themselves.
 *
 * This decision is the whole fix for a real outage: code needing a new column
 * shipped, the column was never added, and every request asked for something
 * that did not exist. Getting the decision wrong in one direction leaves that
 * outage possible; wrong in the other, a dealership's live database changes
 * shape with nobody watching.
 */

const ORIGINAL = { ...process.env };

/** Reloads the config and the decision under a given environment. */
async function withEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Exercised through the module's own seam rather than by exporting the
  // predicate: what matters is the decision the running code reaches.
  const { shouldMigrateForTests } = await import('../../src/server/db/auto-migrate');
  return shouldMigrateForTests();
}

const DEMO = {
  DEMO_MODE: 'true',
  DEMO_PORTAL_PASSWORD: 'compass-showroom-0000',
  NEXT_PUBLIC_SUPABASE_URL: undefined,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
};

beforeEach(() => {
  process.env = { ...ORIGINAL, DATABASE_URL: 'postgres://localhost/x' };
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe('a demonstration deployment', () => {
  it('migrates itself', async () => {
    // It already seeds itself and hands out a shared password, and there is
    // no operator standing by. This is the deployment that broke.
    expect(await withEnv({ ...DEMO, AUTO_MIGRATE: undefined })).toBe(true);
  });

  it('can still be told not to', async () => {
    expect(await withEnv({ ...DEMO, AUTO_MIGRATE: 'false' })).toBe(false);
  });
});

describe('any other deployment', () => {
  it('does not migrate itself unless asked', async () => {
    // A real dealership's schema should change under supervision, not on a
    // cold start nobody saw.
    expect(
      await withEnv({ DEMO_MODE: 'false', DEMO_PORTAL_PASSWORD: undefined, AUTO_MIGRATE: undefined }),
    ).toBe(false);
  });

  it('migrates when explicitly asked', async () => {
    expect(
      await withEnv({ DEMO_MODE: 'false', DEMO_PORTAL_PASSWORD: undefined, AUTO_MIGRATE: 'true' }),
    ).toBe(true);
  });
});

describe('where it runs from', () => {
  it('waits for the schema before the first query, on both entry points', () => {
    // Every query reaches the database through one of these two. A migration
    // that has not been applied by then is a column the running code will ask
    // for and not find.
    const source = readFileSync('src/server/db/tenant-db.ts', 'utf8');
    expect(source).toMatch(/await ensureSchema\(\);\n\n  return unscopedDb\.transaction/);
    expect(source).toMatch(/reason !== 'migration'\) await ensureSchema\(\)/);
  });

  it('is not wired through instrumentation.ts', () => {
    // The obvious home, and the wrong one: Next compiles that file for the
    // edge runtime too and follows the migrator's imports into a bundle with
    // no `node:fs`. A runtime guard stops execution, not bundling — the build
    // fails outright. Kept as a test because the obvious thing looks correct.
    expect(() => readFileSync('src/instrumentation.ts', 'utf8')).toThrow();
  });

  it('never takes the site down when a migration fails', () => {
    // A migration that cannot be applied already breaks the request that
    // needs it, with an error naming the real problem. Throwing here would
    // replace that with a dead instance and no explanation.
    const source = readFileSync('src/server/db/auto-migrate.ts', 'utf8');
    expect(source).toMatch(/catch \(error\) \{[\s\S]*console\.error/);
  });
});
