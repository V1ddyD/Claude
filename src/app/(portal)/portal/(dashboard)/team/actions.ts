'use server';

import { revalidatePath } from 'next/cache';
import { withStaff } from '@/server/auth/require-staff';
import {
  addMember, changeMemberRole, removeMember, resetMemberPassword, type TeamResult,
} from '@/server/services/team';

/**
 * Team changes. Each one re-checks, on the server, that the person asking may
 * manage staff, and the service re-checks every rule about whom they may
 * change: the page only decides which buttons to show.
 *
 * Results come back in the response, not the address bar, because a
 * temporary password must never end up in browser history or server logs.
 */

export async function addMemberAction(_previous: TeamResult | null, formData: FormData): Promise<TeamResult> {
  const result = await withStaff('staff.manage', (db, staff) =>
    addMember(db, staff, {
      fullName: String(formData.get('fullName') ?? ''),
      email: String(formData.get('email') ?? ''),
      role: String(formData.get('role') ?? ''),
    }),
  );
  revalidatePath('/portal/team');
  return result;
}

export async function memberAction(_previous: TeamResult | null, formData: FormData): Promise<TeamResult> {
  const staffId = String(formData.get('staffId') ?? '');
  const intent = String(formData.get('intent') ?? '');
  const result = await withStaff('staff.manage', (db, staff) => {
    if (intent === 'remove') return removeMember(db, staff, staffId);
    if (intent === 'reset') return resetMemberPassword(db, staff, staffId);
    if (intent === 'role') return changeMemberRole(db, staff, staffId, String(formData.get('role') ?? ''));
    return Promise.resolve<TeamResult>({ ok: false, message: 'Unknown action.' });
  });
  // A removal is shown on the card itself, so the list is not refreshed under
  // it: refreshing would take the card, and its confirmation, off the page.
  if (!(result.ok && result.removed)) revalidatePath('/portal/team');
  return result;
}
