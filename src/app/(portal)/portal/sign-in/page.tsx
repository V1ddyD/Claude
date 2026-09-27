import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import {
  currentSessionToken, getAuthSubject, SESSION_COOKIE, sessionCookieOptions,
} from '@/server/auth/session';
import { signIn } from '@/server/auth/staff-auth';
import { configuredProviders, PROVIDER_NAMES, type Provider } from '@/server/auth/oauth';
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
 * Every business signs in here, with an email and password or with Google,
 * Facebook or Apple; which business they see is decided by the account, never
 * by the address. A provider button appears only when that provider is fully
 * set up. Nothing on this page lists anybody's staff.
 */

/** What a rejected sign-in is told. By code, from this list only. */
const ERRORS: Record<string, string> = {
  invalid: "That email and password don't match an account.",
  rate_limited: 'Too many attempts. Please wait 15 minutes and try again.',
  no_account:
    "That email isn't on a business account here. Ask the owner of your business to add you on their Team page, using the same email.",
  no_email: "We couldn't get an email address from that account. Try another way to sign in.",
  unverified: "That account's email address hasn't been verified yet. Verify it with the provider, or sign in with your password.",
  private_relay:
    "Apple hid your email address, so we can't match it to your business. Sign in with Apple again and choose Share My Email.",
  cancelled: 'Sign-in was cancelled or took too long. Please try again.',
  provider_error: "Something went wrong signing in there. Please try again, or use your email and password.",
  unavailable: "That sign-in option isn't available.",
};

async function clientAddress(): Promise<string | null> {
  const list = await headers();
  return list.get('x-forwarded-for')?.split(',')[0]?.trim() ?? list.get('x-real-ip');
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
    (await cookies()).set(SESSION_COOKIE, result.token, sessionCookieOptions);
    redirect(result.mustChangePassword ? '/portal/set-password' : '/portal');
  }

  const providers = configuredProviders();

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

      {providers.length > 0 && (
        <>
          <div className="space-y-3">
            {providers.map((provider) => (
              <ProviderButton key={provider} provider={provider} />
            ))}
          </div>
          <div className="my-6 flex items-center gap-3 text-xs text-ink-500">
            <span className="h-px flex-1 bg-ink-100" />
            or sign in with email
            <span className="h-px flex-1 bg-ink-100" />
          </div>
        </>
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
    </Frame>
  );
}

/** A provider button, styled the way each provider asks its buttons to look. */
function ProviderButton({ provider }: { provider: Provider }) {
  const styles: Record<Provider, string> = {
    google: 'border border-ink-100 bg-white text-ink-900 hover:bg-ink-50',
    facebook: 'bg-[#1877F2] text-white hover:bg-[#166FE5]',
    apple: 'bg-black text-white hover:bg-ink-800',
  };
  return (
    <a
      href={`/api/auth/${provider}/start`}
      className={`flex w-full items-center justify-center gap-3 py-2.5 text-sm ${styles[provider]}`}
    >
      <ProviderLogo provider={provider} />
      Continue with {PROVIDER_NAMES[provider]}
    </a>
  );
}

function ProviderLogo({ provider }: { provider: Provider }) {
  if (provider === 'google') {
    return (
      <svg aria-hidden width="18" height="18" viewBox="0 0 48 48">
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
      </svg>
    );
  }
  if (provider === 'facebook') {
    return (
      <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M24 12.07C24 5.41 18.63 0 12 0S0 5.41 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.7 4.53-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.88v2.27h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
      </svg>
    );
  }
  return (
    <svg aria-hidden width="16" height="18" viewBox="0 0 17 20" fill="currentColor">
      <path d="M14.1 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.8-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.6-4.1zM11.6 3c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5z" />
    </svg>
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
