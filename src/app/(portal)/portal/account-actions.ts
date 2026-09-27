'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { withStaff } from '@/server/auth/require-staff';
import { changeOwnPassword, endSession, revokeSessions } from '@/server/auth/staff-auth';
import { currentSessionToken, SESSION_COOKIE } from '@/server/auth/session';
import { recordAudit } from '@/server/services/audit';

/**
 * What a signed-in member of staff can do to their own account.
 *
 * Each action re-establishes who is asking from the session, never from the
 * form: a posted staff id would be a way to change somebody else's password.
 */

export async function changePasswordAction(formData: FormData): Promise<void> {
  const forced = formData.get('forced') === '1';
  const back = forced ? '/portal/set-password' : '/portal/account';
  const keepToken = await currentSessionToken();

  const result = await withStaff(async (db, staff) => {
    const outcome = await changeOwnPassword(db, staff, {
      current: String(formData.get('current') ?? ''),
      next: String(formData.get('next') ?? ''),
      confirm: String(formData.get('confirm') ?? ''),
      keepToken,
      forced,
    });
    if (outcome.ok) {
      await recordAudit(db, {
        actor: { type: 'staff', id: staff.authUserId },
        action: 'staff.password_changed',
        entityType: 'staff_user',
        entityId: staff.authUserId,
      });
    }
    return outcome;
  });

  if (!result.ok) redirect(`${back}?problem=${result.problem}`);
  redirect(forced ? '/portal' : '/portal/account?done=password');
}

export async function signOutAction(): Promise<void> {
  await endSession(await currentSessionToken());
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/portal/sign-in');
}

export async function signOutEverywhereAction(): Promise<void> {
  const keepToken = await currentSessionToken();
  await withStaff(async (db, staff) => {
    await revokeSessions(db, staff.authUserId, keepToken);
    await recordAudit(db, {
      actor: { type: 'staff', id: staff.authUserId },
      action: 'staff.signed_out_elsewhere',
      entityType: 'staff_user',
      entityId: staff.authUserId,
    });
  });
  redirect('/portal/account?done=signed_out');
}

