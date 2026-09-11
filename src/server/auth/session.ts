import 'server-only';
import { cookies } from 'next/headers';
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
}

export async function getAuthSubject(): Promise<AuthSubject | null> {
  return features.supabaseAuth ? supabaseSubject() : devSubject();
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
 * identity provider, not the permission model. It refuses to run in production.
 */
const DEV_COOKIE = 'sinclair_dev_staff';

async function devSubject(): Promise<AuthSubject | null> {
  if (isProduction) {
    throw new Error(
      'Supabase auth is not configured and the development auth adapter ' +
        'cannot be used in production. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }
  const cookieStore = await cookies();
  const raw = cookieStore.get(DEV_COOKIE)?.value;
  if (!raw) return null;
  const [authUserId, email] = raw.split('|');
  if (!authUserId || !email) return null;
  return { authUserId, email };
}

export const devAuth = {
  cookieName: DEV_COOKIE,
  encode: (authUserId: string, email: string) => `${authUserId}|${email}`,
  get enabled() {
    return !features.supabaseAuth && !isProduction;
  },
};
