import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { devAuth, getAuthSubject } from '@/server/auth/session';
import { listDevAccounts, findDevAccount } from '@/server/auth/dev-directory';
import { verifyDemoPassword } from '@/server/auth/demo-portal';
import { features } from '@/server/config/env';

/**
 * Never prerendered. The portal is per-request by nature: it reads a session
 * and queries tenant-scoped data, neither of which exists at build time.
 */
export const dynamic = 'force-dynamic';


export const metadata = { title: 'Sign in' };

/**
 * Staff sign-in.
 *
 * Where Supabase is configured this hands off to it. Where it is not — local
 * development and the demo environment — a development adapter signs in as a
 * seeded staff member. The adapter replaces the identity provider only: the
 * account must still exist and be active in `staff_users`, and every
 * permission check downstream is unchanged. It refuses to load in production.
 */
/** What a rejected sign-in is told. Never which part was wrong. */
const ERRORS: Record<string, string> = {
  'wrong-password': 'That password was not right. Please try again.',
  'unknown-account': 'That account is no longer available. Choose another.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getAuthSubject()) redirect('/portal');

  // A rejected sign-in redirects back here with a reason. Without rendering it
  // the page looked identical to the one just submitted, so a wrong password
  // was indistinguishable from the portal being broken.
  const error = ERRORS[(await searchParams).error ?? ''];

  if (!devAuth.enabled) {
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

  const accounts = await listDevAccounts();

  async function signInAs(formData: FormData) {
    'use server';
    const id = String(formData.get('id') ?? '');

    // On a demonstration deployment the picker is public but the sign-in is
    // not. Checked server-side, in constant time, on every submission — the
    // form being rendered proves nothing about who is submitting it.
    if (features.demoPortal && !verifyDemoPassword(String(formData.get('password') ?? ''))) {
      redirect('/portal/sign-in?error=wrong-password');
    }

    // Re-read the account server-side. The form is untrusted input: a posted id
    // for a suspended or non-existent account must not produce a session.
    const account = await findDevAccount(id);
    if (!account) redirect('/portal/sign-in?error=unknown-account');

    const store = await cookies();
    store.set(devAuth.cookieName, devAuth.encode(account.id, account.email), {
      httpOnly: true,
      sameSite: 'lax',
      secure: false, // development adapter only; production uses Supabase
      path: '/',
      maxAge: 60 * 60 * 8,
    });
    redirect('/portal');
  }

  return (
    <Frame>
      <p className="text-sm text-ink-500">
        {features.demoPortal
          ? 'Demonstration sign-in. Choose a member of staff to see the portal as they ' +
            'would. Authorization is unchanged — each account carries its real role and ' +
            'permissions.'
          : 'Development sign-in. No identity provider is configured, so the portal ' +
            'authenticates against seeded staff accounts. Authorization is unchanged — ' +
            'each account carries its real role and permissions.'}
      </p>

      {features.demoPortal && (
        <p className="mt-4 text-sm text-ink-500">
          The portal shows enquiries left by visitors, so it is password protected.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 border-l-2 border-accent-600 bg-ink-50 px-3 py-2 text-sm text-accent-600"
        >
          {error}
        </p>
      )}

      <ul className="mt-6 divide-y divide-ink-100 border-y border-ink-100">
        {accounts.map((account) => (
          <li key={account.id}>
            <form action={signInAs}>
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
                <span>
                  <span className="block text-sm text-ink-900">{account.fullName}</span>
                  <span className="block text-xs text-ink-500">{account.email}</span>
                </span>
                <span className="text-right text-[11px] uppercase tracking-wider text-ink-500">
                  {account.role}
                  <span className="block text-ink-300">{account.tenantSlug}</span>
                </span>
              </button>
            </form>
          </li>
        ))}
      </ul>
      {features.demoPortal && (
        <p className="mt-4 text-xs text-ink-500">
          Everything here is fictional seed data for one demonstration dealership.
        </p>
      )}

      {accounts.length === 0 && (
        <p className="mt-6 text-sm text-accent-600">
          No active staff accounts. Run <code>npm run db:seed</code>.
        </p>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Sinclair</p>
      <h1 className="mt-3 text-2xl font-medium tracking-tight text-ink-900">Dealer Portal</h1>
      <div className="mt-8">{children}</div>
    </main>
  );
}

