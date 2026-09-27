import { redirect } from 'next/navigation';
import { requireStaff } from '@/server/auth/require-staff';
import { isAppError } from '@/server/errors';
import { PASSWORD_MESSAGES, type PasswordProblem } from '@/server/auth/passwords';
import { changePasswordAction, signOutAction } from '../account-actions';
import { PasswordFields } from '../password-fields';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Choose a password' };

/**
 * The first thing somebody sees after signing in with a password that was
 * chosen for them: a new account, or one the owner has reset. Nothing else in
 * the portal opens until it is replaced, because the temporary one has been
 * seen by somebody else.
 */
export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string }>;
}) {
  let staff;
  try {
    staff = await requireStaff();
  } catch (err) {
    if (isAppError(err)) redirect('/portal/sign-in');
    throw err;
  }
  if (!staff.mustChangePassword) redirect('/portal');

  const code = (await searchParams).problem;
  const problem = code && code in PASSWORD_MESSAGES ? PASSWORD_MESSAGES[code as PasswordProblem] : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Business Portal</p>
      <h1 className="mt-3 text-2xl font-medium tracking-tight text-ink-900">Choose your password</h1>
      <p className="mt-3 text-sm text-ink-500">
        Welcome, {staff.fullName.split(' ')[0]}. You signed in with a temporary password, so please
        choose your own before continuing.
      </p>
      {problem && (
        <p role="alert" className="mt-6 border-l-2 border-accent-600 bg-ink-50 px-3 py-2 text-sm text-accent-600">
          {problem}
        </p>
      )}
      <form action={changePasswordAction} className="mt-8">
        <input type="hidden" name="forced" value="1" />
        <PasswordFields askCurrent={false} />
        <button type="submit" className="mt-6 w-full bg-ink-900 py-2.5 text-sm text-white hover:bg-ink-800">
          Save and continue
        </button>
      </form>
      <form action={signOutAction} className="mt-4">
        <button type="submit" className="text-xs text-ink-500 underline-offset-2 hover:underline">
          Sign out
        </button>
      </form>
    </main>
  );
}
