import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';

/**
 * Signing in with Google, Facebook and Apple.
 *
 * The providers are faked at the network edge; everything else is real. What
 * matters: a login flow cannot be finished by someone who did not start it, a
 * token issued to another app or another sign-in is refused, an unverified or
 * hidden email is refused, and a verified email only gets in if a business
 * has that person on its team.
 */

process.env.GOOGLE_CLIENT_ID = 'google-client.apps.test';
process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
process.env.FACEBOOK_APP_ID = 'fb-app';
process.env.FACEBOOK_APP_SECRET = 'fb-secret';

let admin: Sql;
let oauth: typeof import('../../src/server/auth/oauth');
let auth: typeof import('../../src/server/auth/staff-auth');
let team: typeof import('../../src/server/services/team');

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
  oauth = await import('../../src/server/auth/oauth');
  auth = await import('../../src/server/auth/staff-auth');
  team = await import('../../src/server/services/team');
});
afterEach(() => oauth.setOAuthFetch(null));
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

function idToken(claims: Record<string, unknown>): string {
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

/** Google's token endpoint, answering with an ID token of our choosing. */
function google(claims: (nonce: string) => Record<string, unknown>, nonce: { value: string }) {
  oauth.setOAuthFetch((async () =>
    new Response(JSON.stringify({ id_token: idToken(claims(nonce.value)) }), { status: 200 })) as typeof fetch);
}

async function aBusinessWith(email: string) {
  const tenantId = randomUUID();
  const slug = `soc-${tenantId.slice(0, 8)}`;
  await admin`INSERT INTO tenants (id, slug, legal_name, brand_name, ticket_prefix, plan)
              VALUES (${tenantId}, ${slug}, ${slug}, ${slug}, 'SOC', 'pro')`;
  const id = randomUUID();
  await admin`INSERT INTO staff_users (id, tenant_id, email, full_name, role, status)
              VALUES (${id}, ${tenantId}, ${email}, 'Social Person', 'sales', 'active')`;
  return { tenantId, slug, id };
}

describe('the state that ties a sign-in to this browser', () => {
  it('opens only for the same provider, the same returned value, and in time', () => {
    const state = oauth.newState('google');
    const sealed = oauth.sealState(state);
    expect(oauth.openState(sealed, 'google', state.state)).not.toBeNull();
    expect(oauth.openState(sealed, 'facebook', state.state)).toBeNull();
    expect(oauth.openState(sealed, 'google', 'somebody-elses-state')).toBeNull();
    expect(oauth.openState(undefined, 'google', state.state)).toBeNull();
    expect(oauth.openState(oauth.sealState({ ...state, expires: Date.now() - 1 }), 'google', state.state)).toBeNull();
  });

  it('refuses a cookie that has been edited', () => {
    const state = oauth.newState('google');
    const [, signature] = oauth.sealState(state).split('.');
    const forged = Buffer.from(JSON.stringify({ ...state, provider: 'google', expires: Date.now() + 1e9 })).toString('base64url');
    expect(oauth.openState(`${forged}.${signature}`, 'google', state.state)).toBeNull();
  });

  it('sends Google a PKCE challenge and a nonce', () => {
    const state = oauth.newState('google');
    const url = new URL(oauth.authorizationUrl('google', state, 'https://portal.test/api/auth/google/callback'));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).not.toBe(state.verifier);
    expect(url.searchParams.get('nonce')).toBe(state.nonce);
    expect(url.searchParams.get('state')).toBe(state.state);
  });
});

describe('what a provider must prove', () => {
  const base = (nonce: string) => ({
    iss: 'https://accounts.google.com',
    aud: 'google-client.apps.test',
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce,
    email: 'Person@Example.test',
    email_verified: true,
  });

  it('accepts a verified email in a token meant for us', async () => {
    const state = oauth.newState('google');
    google(base, { value: state.nonce });
    expect(await oauth.verifiedEmail('google', 'code', state, 'https://x/cb')).toEqual({ ok: true, email: 'person@example.test' });
  });

  it('refuses an unverified email, a token for another app, another sign-in, or one that has expired', async () => {
    const state = oauth.newState('google');
    for (const [claims, reason] of [
      [(n: string) => ({ ...base(n), email_verified: false }), 'unverified'],
      [(n: string) => ({ ...base(n), aud: 'someone-elses-app' }), 'provider_error'],
      [() => ({ ...base('a-different-sign-in') }), 'provider_error'],
      [(n: string) => ({ ...base(n), exp: Math.floor(Date.now() / 1000) - 10 }), 'provider_error'],
      [(n: string) => ({ ...base(n), iss: 'https://evil.test' }), 'provider_error'],
    ] as const) {
      google(claims as (n: string) => Record<string, unknown>, { value: state.nonce });
      expect(await oauth.verifiedEmail('google', 'code', state, 'https://x/cb')).toEqual({ ok: false, reason });
    }
  });

  it('refuses a Facebook account with no email', async () => {
    oauth.setOAuthFetch((async (url: string | URL | Request) =>
      String(url).includes('access_token?')
        ? new Response(JSON.stringify({ access_token: 'fb-token' }))
        : new Response(JSON.stringify({ id: '1' }))) as typeof fetch);
    const state = oauth.newState('facebook');
    expect(await oauth.verifiedEmail('facebook', 'code', state, 'https://x/cb')).toEqual({ ok: false, reason: 'no_email' });
  });
});

describe('getting in', () => {
  it('lets in a verified email that a business has on its team', async () => {
    const email = `social-${randomUUID().slice(0, 8)}@example.test`;
    const b = await aBusinessWith(email);
    const result = await auth.signInWithVerifiedEmail(email, '10.20.30.40');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await auth.sessionSubject(result.token)).toMatchObject({ authUserId: b.id, tenantId: b.tenantId });
  });

  it('keeps out a verified email nobody has added', async () => {
    expect(await auth.signInWithVerifiedEmail(`stranger-${randomUUID()}@gmail.test`, '10.20.30.41')).toEqual({
      ok: false,
      reason: 'no_account',
    });
  });

  it('keeps out someone who was removed', async () => {
    const email = `removed-${randomUUID().slice(0, 8)}@example.test`;
    const b = await aBusinessWith(email);
    await admin`UPDATE staff_users SET status = 'suspended' WHERE id = ${b.id}`;
    expect((await auth.signInWithVerifiedEmail(email, '10.20.30.42')).ok).toBe(false);
  });

  it('retires a temporary password once they sign in another way', async () => {
    const email = `temp-${randomUUID().slice(0, 8)}@example.test`;
    const b = await aBusinessWith(email);
    await withTenant(b.tenantId, (db) => auth.setTemporaryPassword(db, b.id, email, 'Temp-Password-99'));
    const result = await auth.signInWithVerifiedEmail(email, '10.20.30.43');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No password left for whoever saw the temporary one, and no forced change.
    expect((await auth.signIn({ email, password: 'Temp-Password-99', ip: '10.20.30.44' })).ok).toBe(false);
    expect((await auth.sessionSubject(result.token))?.mustChangePassword).toBe(false);
  });
});

describe('the operator tool', () => {
  it('creates an owner with a temporary password they must replace', async () => {
    const b = await aBusinessWith(`someone-${randomUUID().slice(0, 8)}@example.test`);
    const email = `owner-${randomUUID().slice(0, 8)}@example.test`;
    const made = await withTenant(b.tenantId, (db) => team.provisionOwner(db, { email, fullName: 'New Owner' }));
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const signedIn = await auth.signIn({ email, password: made.temporaryPassword, ip: '10.20.30.45' });
    expect(signedIn).toMatchObject({ ok: true, mustChangePassword: true });
    const [row] = await admin<{ role: string }[]>`SELECT role FROM staff_users WHERE email = ${email}`;
    expect(row!.role).toBe('admin');
  });
});
