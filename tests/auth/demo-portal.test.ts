import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The demonstration portal gate, exercised rather than described.
 *
 * A public demo deployment lets anyone find the Dealer Portal, and the portal
 * shows leads assembled from whatever visitors typed into the chat —
 * inevitably including some real names and real email addresses. So the staff
 * picker is available there only behind a password, and only when the
 * deployment has explicitly asked to be a demonstration.
 *
 * Authorization itself is untouched by any of this: each account still carries
 * its real role, and tests/auth/permissions.test.ts is unchanged.
 */

const ORIGINAL = { ...process.env };

/** Reloads the config and the gate under a given environment. */
async function withEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('../../src/server/auth/demo-portal');
}

beforeEach(() => {
  process.env = { ...ORIGINAL };
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe('the password', () => {
  const on = {
    DEMO_MODE: 'true',
    DEMO_PORTAL_PASSWORD: 'showroom-demo-2026',
    NEXT_PUBLIC_SUPABASE_URL: undefined,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
  };

  it('accepts the configured one', async () => {
    const { verifyDemoPassword } = await withEnv(on);
    expect(verifyDemoPassword('showroom-demo-2026')).toBe(true);
  });

  it('refuses anything else', async () => {
    const { verifyDemoPassword } = await withEnv(on);
    for (const attempt of [
      '',
      'wrong',
      'showroom-demo-202',       // a prefix
      'showroom-demo-2026 ',     // trailing space
      'Showroom-Demo-2026',      // different case
      'showroom-demo-2026extra', // a suffix
    ]) {
      expect.soft(verifyDemoPassword(attempt), JSON.stringify(attempt)).toBe(false);
    }
  });

  it('does not throw on a length mismatch, which would disclose the length', async () => {
    const { verifyDemoPassword } = await withEnv(on);
    expect(() => verifyDemoPassword('x')).not.toThrow();
    expect(() => verifyDemoPassword('x'.repeat(5000))).not.toThrow();
  });
});

describe('when demo mode is off', () => {
  it('no password unlocks anything', async () => {
    const { verifyDemoPassword } = await withEnv({
      DEMO_MODE: 'false',
      DEMO_PORTAL_PASSWORD: 'showroom-demo-2026',
    });
    expect(verifyDemoPassword('showroom-demo-2026')).toBe(false);
  });

  it('is the default, so a deployment cannot open the portal by omission', async () => {
    const { verifyDemoPassword } = await withEnv({
      DEMO_MODE: undefined,
      DEMO_PORTAL_PASSWORD: 'showroom-demo-2026',
    });
    expect(verifyDemoPassword('showroom-demo-2026')).toBe(false);
  });
});

describe('when a real identity provider is configured', () => {
  it('demo mode cannot override it', async () => {
    // Supabase present: the portal authenticates against Supabase, and the
    // demonstration picker must not be a way around that.
    const { verifyDemoPassword } = await withEnv({
      DEMO_MODE: 'true',
      DEMO_PORTAL_PASSWORD: 'showroom-demo-2026',
      NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    });
    expect(verifyDemoPassword('showroom-demo-2026')).toBe(false);
  });
});

describe('configuration', () => {
  it('refuses to start with demo mode on and no password', async () => {
    vi.resetModules();
    process.env.DEMO_MODE = 'true';
    delete process.env.DEMO_PORTAL_PASSWORD;

    const { env } = await import('../../src/server/config/env');
    // Validation is lazy, so the throw happens on the first read.
    expect(() => env.DEMO_MODE).toThrow(/DEMO_PORTAL_PASSWORD/);
  });

  it('rejects a password too short to be one', async () => {
    vi.resetModules();
    process.env.DEMO_MODE = 'true';
    process.env.DEMO_PORTAL_PASSWORD = 'short';

    const { env } = await import('../../src/server/config/env');
    expect(() => env.DEMO_MODE).toThrow(/DEMO_PORTAL_PASSWORD/);
  });
});

describe('the pages', () => {
  it('ask for the password and never render it', async () => {
    const signIn = readFileSync('src/app/(portal)/portal/sign-in/page.tsx', 'utf8');
    expect(signIn).toContain('verifyDemoPassword');
    expect(signIn).toMatch(/type="password"/);
    expect(signIn).not.toMatch(/DEMO_PORTAL_PASSWORD/);
    // The account is still re-read, so a posted id cannot invent a session.
    expect(signIn).toContain('findDevAccount');
  });

  it('tell a visitor the site is a demonstration', async () => {
    const layout = readFileSync('src/app/(site)/layout.tsx', 'utf8');
    expect(layout).toContain('features.demoPortal');
    expect(layout).toMatch(/not a real appointment/i);
  });

  it('keep the staff adapter refused in production otherwise', async () => {
    const session = readFileSync('src/server/auth/session.ts', 'utf8');
    expect(session).toContain('isProduction && !features.demoPortal');
  });
});
