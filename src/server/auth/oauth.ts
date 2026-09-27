import 'server-only';
import { createHash, createHmac, createPrivateKey, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import { env, isProduction } from '@/server/config/env';

/**
 * Sign in with Google, Facebook or Apple.
 *
 * What these providers are trusted for is exactly one thing: that the person
 * controls a verified email address. Who that person may be in the portal is
 * still decided by the business's own team list. A Google account nobody
 * added to a team gets nowhere, however valid it is.
 *
 * The flow is the standard authorisation-code flow, with every check the
 * standards ask for:
 *
 *   state    a random value, carried in a signed, short-lived cookie and
 *            matched on return, so a login cannot be started by somebody else
 *            and finished in your browser
 *   PKCE     for Google, a secret the code is useless without
 *   nonce    bound into the ID token, so a token cannot be replayed from
 *            another sign-in
 *   the token itself comes straight from the provider's token endpoint over
 *            TLS with our client secret, which is how OpenID Connect allows
 *            its issuer to be established; its issuer, audience, expiry and
 *            nonce are still checked
 */

export type Provider = 'google' | 'facebook' | 'apple';

export const PROVIDER_NAMES: Record<Provider, string> = {
  google: 'Google',
  facebook: 'Facebook',
  apple: 'Apple',
};

/** Only providers with every credential present are offered. */
export function configuredProviders(): Provider[] {
  const out: Provider[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.push('google');
  if (env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET) out.push('facebook');
  if (env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) out.push('apple');
  return out;
}

export function isProvider(value: string): value is Provider {
  return value === 'google' || value === 'facebook' || value === 'apple';
}

/* -------------------------------------------------------------------------- */
/* The signed state cookie                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Apple returns by POSTing a form from its own site, and a cookie is only sent
 * on that cross-site request when it is SameSite=None; it is Secure and
 * lives ten minutes. Everywhere else Lax would do, but one cookie is simpler
 * than two, and its contents are signed and single-use either way.
 */
export const STATE_COOKIE = isProduction ? '__Host-oauth_state' : 'oauth_state';
export const stateCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
  maxAge: 600,
};

export interface OAuthState {
  provider: Provider;
  state: string;
  nonce: string;
  verifier: string;
  expires: number;
}

let devKey: Buffer | undefined;
function signingKey(): Buffer {
  if (env.SESSION_SECRET) return Buffer.from(env.SESSION_SECRET);
  if (isProduction) throw new Error('SESSION_SECRET is required to sign in with an external provider.');
  devKey ??= randomBytes(32);
  return devKey;
}

function mac(value: string): string {
  return createHmac('sha256', signingKey()).update(value).digest('base64url');
}

export function newState(provider: Provider): OAuthState {
  return {
    provider,
    state: randomBytes(24).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
    verifier: randomBytes(48).toString('base64url'),
    expires: Date.now() + 600_000,
  };
}

export function sealState(state: OAuthState): string {
  const body = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${body}.${mac(body)}`;
}

/** The state from the cookie, if it is ours, unexpired, and for this provider and this return. */
export function openState(cookie: string | undefined, provider: Provider, returnedState: string | null): OAuthState | null {
  if (!cookie || !returnedState) return null;
  const [body, signature] = cookie.split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(mac(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let state: OAuthState;
  try {
    state = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthState;
  } catch {
    return null;
  }
  if (state.provider !== provider || state.expires < Date.now()) return null;
  const a = Buffer.from(state.state);
  const b = Buffer.from(returnedState);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return state;
}

/* -------------------------------------------------------------------------- */
/* Where to send the person                                                   */
/* -------------------------------------------------------------------------- */

export function callbackUrl(origin: string, provider: Provider): string {
  return `${origin}/api/auth/${provider}/callback`;
}

export function authorizationUrl(provider: Provider, state: OAuthState, redirectUri: string): string {
  if (provider === 'google') {
    const challenge = createHash('sha256').update(state.verifier).digest('base64url');
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: state.state,
      nonce: state.nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    })}`;
  }
  if (provider === 'facebook') {
    return `https://www.facebook.com/dialog/oauth?${new URLSearchParams({
      client_id: env.FACEBOOK_APP_ID!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'email',
      state: state.state,
    })}`;
  }
  return `https://appleid.apple.com/auth/authorize?${new URLSearchParams({
    client_id: env.APPLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'email',
    state: state.state,
    nonce: state.nonce,
  })}`;
}

/* -------------------------------------------------------------------------- */
/* Coming back: the verified email                                            */
/* -------------------------------------------------------------------------- */

export type VerifiedEmail =
  | { ok: true; email: string }
  | { ok: false; reason: 'no_email' | 'unverified' | 'private_relay' | 'provider_error' };

/** Test seam: the provider's endpoints, replaced in tests. */
let fetcher: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });
export function setOAuthFetch(next: typeof fetch | null): void {
  fetcher = next ?? ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }));
}

function claims(idToken: string): Record<string, unknown> | null {
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function checkIdToken(
  token: Record<string, unknown> | null,
  expected: { issuers: string[]; audience: string; nonce: string },
): VerifiedEmail {
  if (!token) return { ok: false, reason: 'provider_error' };
  const audience = Array.isArray(token.aud) ? token.aud : [token.aud];
  if (
    !expected.issuers.includes(String(token.iss)) ||
    !audience.includes(expected.audience) ||
    typeof token.exp !== 'number' ||
    token.exp * 1000 < Date.now() ||
    token.nonce !== expected.nonce
  ) {
    return { ok: false, reason: 'provider_error' };
  }
  if (typeof token.email !== 'string' || !token.email.includes('@')) return { ok: false, reason: 'no_email' };
  if (token.email_verified !== true && token.email_verified !== 'true') return { ok: false, reason: 'unverified' };
  if (token.is_private_email === true || token.is_private_email === 'true') {
    return { ok: false, reason: 'private_relay' };
  }
  return { ok: true, email: token.email.toLowerCase() };
}

/** Apple's client secret: a short-lived JWT signed with the team's key. */
function appleClientSecret(): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', kid: env.APPLE_KEY_ID })}.${encode({
    iss: env.APPLE_TEAM_ID,
    iat: now,
    exp: now + 300,
    aud: 'https://appleid.apple.com',
    sub: env.APPLE_CLIENT_ID,
  })}`;
  const key = createPrivateKey(env.APPLE_PRIVATE_KEY!.replace(/\\n/g, '\n'));
  const signature = createSign('SHA256').update(unsigned).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${signature.toString('base64url')}`;
}

export async function verifiedEmail(
  provider: Provider,
  code: string,
  state: OAuthState,
  redirectUri: string,
): Promise<VerifiedEmail> {
  try {
    if (provider === 'google') {
      const response = await fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: state.verifier,
        }),
      });
      const body = (await response.json()) as { id_token?: string };
      if (!response.ok || !body.id_token) return { ok: false, reason: 'provider_error' };
      return checkIdToken(claims(body.id_token), {
        issuers: ['https://accounts.google.com', 'accounts.google.com'],
        audience: env.GOOGLE_CLIENT_ID!,
        nonce: state.nonce,
      });
    }

    if (provider === 'apple') {
      const response = await fetcher('https://appleid.apple.com/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.APPLE_CLIENT_ID!,
          client_secret: appleClientSecret(),
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const body = (await response.json()) as { id_token?: string };
      if (!response.ok || !body.id_token) return { ok: false, reason: 'provider_error' };
      return checkIdToken(claims(body.id_token), {
        issuers: ['https://appleid.apple.com'],
        audience: env.APPLE_CLIENT_ID!,
        nonce: state.nonce,
      });
    }

    // Facebook: an access token for this app, then the email Facebook holds.
    // Facebook only gives an email the account has confirmed.
    const tokenResponse = await fetcher(
      `https://graph.facebook.com/oauth/access_token?${new URLSearchParams({
        client_id: env.FACEBOOK_APP_ID!,
        client_secret: env.FACEBOOK_APP_SECRET!,
        redirect_uri: redirectUri,
        code,
      })}`,
    );
    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!tokenResponse.ok || !token.access_token) return { ok: false, reason: 'provider_error' };
    const proof = createHmac('sha256', env.FACEBOOK_APP_SECRET!).update(token.access_token).digest('hex');
    const meResponse = await fetcher(
      `https://graph.facebook.com/me?${new URLSearchParams({
        fields: 'id,email',
        access_token: token.access_token,
        appsecret_proof: proof,
      })}`,
    );
    const me = (await meResponse.json()) as { email?: string };
    if (!meResponse.ok) return { ok: false, reason: 'provider_error' };
    if (!me.email || !me.email.includes('@')) return { ok: false, reason: 'no_email' };
    return { ok: true, email: me.email.toLowerCase() };
  } catch {
    return { ok: false, reason: 'provider_error' };
  }
}
