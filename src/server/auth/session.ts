import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { sessionSubject, SESSION_DAYS, type SessionSubject } from './staff-auth';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { env, features, isProduction } from '@/server/config/env';

/**
 * Staff authentication.
 *
 * This module answers exactly one question — "which auth subject is making this
 * request?" — and deliberately nothing more. It returns a user id, never a role
 * and never a tenant. Those come from `staff_users`, because a token that could
 * assert its own role would make the permission matrix decorative.
 */

export interface AuthSubject {
  authUserId: string;
  email: string;
  /** Signed in with a password somebody else chose, which must be replaced first. */
  mustChangePassword?: boolean;
}

export async function getAuthSubject(): Promise<AuthSubject | null> {
  return features.supabaseAuth ? supabaseSubject() : portalSubject();
}

async function supabaseSubject(): Promise<AuthSubject | null> {
  const cookieStore = await cookies();
  const client = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL!,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (items: { name: string; value: string; options: CookieOptions }[]) => {
          try {
            for (const { name, value, options } of items) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Session refresh happens in middleware instead.
          }
        },
      },
    },
  );

  // getUser() revalidates the token with the auth server. getSession() reads it
  // from the cookie without verification, which is forgeable.
  const { data, error } = await client.auth.getUser();
  if (error || !data.user?.email) return null;
  return { authUserId: data.user.id, email: data.user.email };
}

/**
 * Development-only adapter: a signed cookie naming a seeded staff member, so the
 * portal can be built and demonstrated without provisioning a Supabase project.
 *
 * It still authorizes against the real `staff_users` table — it replaces the
 * identity provider, not the permission model. It refuses to run in production
 * unless the deployment is an explicitly flagged, password-gated demonstration.
 */
/**
 * The portal session cookie.
 *
 * A random token, meaningless on its own: the database holds its SHA-256 and
 * decides who it belongs to, so it cannot be forged by editing it, and it
 * stops working the moment the session is ended. `__Host-` in production
 * pins it to this host, HTTPS only and the whole site, so no subdomain or
 * plain-HTTP page can set or read it.
 */
export const SESSION_COOKIE = isProduction ? '__Host-portal_session' : 'portal_session';

export const sessionCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_DAYS * 86_400,
};

/** Once per request, however many components ask. */
const currentSession = cache(async (): Promise<SessionSubject | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return sessionSubject(token);
});

async function portalSubject(): Promise<AuthSubject | null> {
  const session = await currentSession();
  return session
    ? { authUserId: session.authUserId, email: session.email, mustChangePassword: session.mustChangePassword }
    : null;
}

/** The raw token, for ending this session or keeping it while ending the others. */
export async function currentSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Whether the demonstration picker may be offered on this deployment. */
export const demoSignIn = {
  get enabled() {
    return !features.supabaseAuth && (!isProduction || features.demoPortal);
  },
};
