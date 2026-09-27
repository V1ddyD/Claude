import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { and, asc, eq } from 'drizzle-orm';
import {
  currentSessionToken, demoSignIn, getAuthSubject, SESSION_COOKIE, sessionCookieOptions,
} from '@/server/auth/session';
import { signIn, startSession } from '@/server/auth/staff-auth';
import { verifyDemoPassword } from '@/server/auth/demo-portal';
import { resolveTenantByHost } from '@/server/context/tenant';
import { withTenant } from '@/server/db/tenant-db';
import { staffUsers } from '@/server/db/schema';
import { features } from '@/server/config/env';
import { checkRateLimit } from '@/server/services/limits';
import { createHash } from 'node:crypto';

/**
 * Never prerendered. The portal is per-request by nature: it reads a session
 * and queries tenant-scoped data, neither of which exists at build time.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Sign in' };

/**
 * Staff sign-in.
 *
 * Every business signs in here, with an email and a password; which business
 * they see is decided by the account, never by the address. On a
 * demonstration deployment the demonstration business's staff are also
 * offered as one-click accounts, behind the demonstration password, and only
 * that business's: a client's staff are never listed on a public page.
 */

/** What a rejected sign-in is told. Never which part was wrong. */
const ERRORS: Record<string, string> = {
  invalid: "That email and password don't match an account.",
  rate_limited: 'Too many attempts. Please wait 15 minutes and try again.',
  'wrong-password': 'That demonstration password was not right.',
  'unknown-account': 'That account is no longer available. Choose another.',
};

async function clientAddress(): Promise<string | null> {
  const list = await headers();
  return list.get('x-forwarded-for')?.split(',')[0]?.trim() ?? list.get('x-real-ip');
}

async function setSession(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions);
}

/** The business this address belongs to, for the demonstration accounts only. */
async function hostTenantId(): Promise<string | null> {
  try {
    return (await resolveTenantByHost((await headers()).get('host'))).id;
  } catch {
    return null;
  }
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const subject = await getAuthSubject();
  if (subject) redirect(subject.mustChangePassword ? '/portal/set-password' : '/portal');

  const error = ERRORS[(await searchParams).error ?? ''];

  if (features.supabaseAuth) {
    return (
      <Frame>
        <p className="text-sm text-ink-500">
          Staff sign-in is handled by your organisation&apos;s identity provider.
        </p>
        <a
          href="/auth/sign-in"
          className="mt-6 inline-block bg-ink-900 px-5 py-2.5 text-sm text-white hover:bg-ink-800"
        >
          Continue
        </a>
      </Frame>
    );
  }

  async function signInWithPassword(formData: FormData) {
    'use server';
    const result = await signIn({
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      ip: await clientAddress(),
    });
    if (!result.ok) redirect(`/portal/sign-in?error=${result.reason}`);
    // Anything left over from an earlier sign-in on this browser ends here.
    if (await currentSessionToken()) (await cookies()).delete(SESSION_COOKIE);
    await setSession(result.token);
    redirect(result.mustChangePassword ? '/portal/set-password' : '/portal');
  }

  const demoTenant = demoSignIn.enabled ? await hostTenantId() : null;
  const demoAccounts = demoTenant
    ? await withTenant(demoTenant, (db) =>
        db
          .select({ id: staffUsers.id, fullName: staffUsers.fullName, role: staffUsers.role })
          .from(staffUsers)
          .where(and(eq(staffUsers.tenantId, db.tenantId), eq(staffUsers.status, 'active')))
          .orderBy(asc(staffUsers.role), asc(staffUsers.fullName))
          .limit(12),
      )
    : [];

  async function signInAsDemo(formData: FormData) {
    'use server';
    if (!demoSignIn.enabled) redirect('/portal/sign-in');
    // The demonstration password is guessable at the same speed as any other.
    const limit = await checkRateLimit({
      bucket: 'demo-sign-in',
      subject: createHash('sha256').update((await clientAddress()) ?? 'unknown').digest('hex').slice(0, 32),
      max: 10,
      windowSeconds: 900,
    });
    if (!limit.allowed) redirect('/portal/sign-in?error=rate_limited');
    // The picker is public; the sign-in is not. Checked here, in constant time,
    // on every submission: the form being rendered proves nothing.
    if (features.demoPortal && !verifyDemoPassword(String(formData.get('password') ?? ''))) {
      redirect('/portal/sign-in?error=wrong-password');
    }
    const tenantId = await hostTenantId();
    if (!tenantId) redirect('/portal/sign-in?error=unknown-account');
    const id = String(formData.get('id') ?? '');
    // Re-read server-side, inside the demonstration business: a posted id for
    // anyone else, or a removed account, produces nothing.
    const token = await withTenant(tenantId, async (db) => {
      const [staff] = await db
        .select({ id: staffUsers.id })
        .from(staffUsers)
        .where(and(eq(staffUsers.tenantId, db.tenantId), eq(staffUsers.id, id), eq(staffUsers.status, 'active')))
        .limit(1);
      return staff ? startSession(db, staff.id) : null;
    }).catch(() => null);
    if (!token) redirect('/portal/sign-in?error=unknown-account');
    await setSession(token);
    redirect('/portal');
  }

  return (
    <Frame>
      {error && (
        <p
          role="alert"
          className="mb-6 border-l-2 border-accent-600 bg-ink-50 px-3 py-2 text-sm text-accent-600"
        >
          {error}
        </p>
      )}

      <form action={signInWithPassword} className="space-y-4">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-ink-500">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="username"
            className="mt-1 w-full border border-ink-100 bg-white px-3 py-2.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-ink-500">Password</span>
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="mt-1 w-full border border-ink-100 bg-white px-3 py-2.5 text-sm"
          />
        </label>
        <button type="submit" className="w-full bg-ink-900 py-2.5 text-sm text-white hover:bg-ink-800">
          Sign in
        </button>
        <p className="text-xs text-ink-500">
          Forgotten your password? Ask the owner of your business account to reset it.
        </p>
      </form>

      {demoAccounts.length > 0 && (
        <section className="mt-10">
          <h2 className="text-[11px] uppercase tracking-[0.2em] text-ink-500">Demonstration accounts</h2>
          <p className="mt-2 text-sm text-ink-500">
            {features.demoPortal
              ? 'See the portal as a member of the demonstration showroom would. Everything here is fictional.'
              : 'Development sign-in: seeded staff, with their real roles and permissions.'}
          </p>
          <ul className="mt-4 divide-y divide-ink-100 border-y border-ink-100">
            {demoAccounts.map((account) => (
              <li key={account.id}>
                <form action={signInAsDemo}>
                  <input type="hidden" name="id" value={account.id} />
                  {features.demoPortal && (
                    <input
                      type="password"
                      name="password"
                      required
                      placeholder="Demonstration password"
                      aria-label={`Demonstration password to sign in as ${account.fullName}`}
                      className="mt-3 w-full border border-ink-100 px-3 py-2 text-sm"
                    />
                  )}
                  <button
                    type="submit"
                    className="flex w-full items-center justify-between py-3 text-left hover:bg-ink-50"
                  >
                    <span className="text-sm text-ink-900">{account.fullName}</span>
                    <span className="text-[11px] uppercase tracking-wider text-ink-500">
                      {account.role === 'admin' ? 'owner' : account.role}
                    </span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Business Portal</p>
      <h1 className="mt-3 text-2xl font-medium tracking-tight text-ink-900">Sign in</h1>
      <div className="mt-8">{children}</div>
    </main>
  );
}
