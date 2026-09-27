import { withStaff } from '@/server/auth/require-staff';
import { PASSWORD_MESSAGES, type PasswordProblem } from '@/server/auth/passwords';
import { changePasswordAction, signOutAction, signOutEverywhereAction } from '../../account-actions';
import { PasswordFields } from '../../password-fields';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My account' };

const DONE: Record<string, string> = {
  password: 'Your password has been changed. Any other devices have been signed out.',
  signed_out: 'You have been signed out on every other device.',
};

const ROLE_LABEL: Record<string, string> = {
  sales: 'Sales', service: 'Service', manager: 'Manager', admin: 'Owner / administrator',
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string; done?: string }>;
}) {
  const staff = await withStaff(async (_db, s) => s);
  const { problem: code, done } = await searchParams;
  const problem = code && code in PASSWORD_MESSAGES ? PASSWORD_MESSAGES[code as PasswordProblem] : null;
  const notice = done ? DONE[done] : undefined;

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-medium tracking-tight text-ink-900">My account</h1>

      <dl className="mt-6 divide-y divide-ink-100 rounded border border-ink-100 bg-white text-sm">
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-ink-500">Name</dt>
          <dd className="text-ink-900">{staff.fullName}</dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-ink-500">Email</dt>
          <dd className="break-all text-ink-900">{staff.email}</dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-ink-500">Role</dt>
          <dd className="text-ink-900">{ROLE_LABEL[staff.role] ?? staff.role}</dd>
        </div>
      </dl>

      {notice && <p className="mt-6 border-l-2 border-ink-900 bg-white px-3 py-2 text-sm text-ink-900">{notice}</p>}
      {problem && (
        <p role="alert" className="mt-6 border-l-2 border-accent-600 bg-white px-3 py-2 text-sm text-accent-600">
          {problem}
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-[11px] uppercase tracking-[0.2em] text-ink-500">Change password</h2>
        <form action={changePasswordAction} className="mt-4 rounded border border-ink-100 bg-white p-4">
          <PasswordFields askCurrent />
          <button type="submit" className="mt-6 bg-ink-900 px-5 py-2.5 text-sm text-white hover:bg-ink-800">
            Change password
          </button>
        </form>
      </section>

      <section className="mt-10 flex flex-wrap gap-3">
        <form action={signOutEverywhereAction}>
          <button type="submit" className="border border-ink-100 bg-white px-4 py-2.5 text-sm text-ink-900 hover:bg-ink-50">
            Sign out on all other devices
          </button>
        </form>
        <form action={signOutAction}>
          <button type="submit" className="border border-ink-100 bg-white px-4 py-2.5 text-sm text-ink-900 hover:bg-ink-50">
            Sign out
          </button>
        </form>
      </section>
    </div>
  );
}
