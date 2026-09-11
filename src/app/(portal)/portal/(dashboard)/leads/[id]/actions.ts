'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { withStaff } from '@/server/auth/require-staff';
import { changeStatus, assignLead, addStaffNote } from '@/server/services/leads/actions';
import { completeFollowUp } from '@/server/services/follow-ups';
import { toPublicError } from '@/server/errors';
import type { LeadStatus } from '@/server/db/schema';

/**
 * Portal server actions.
 *
 * Every one re-authorizes. A server action is a public endpoint with a
 * generated name — the fact that the button is only rendered for a manager
 * proves nothing about who can invoke it.
 *
 * Input is validated here too: the form is untrusted, exactly like a request body.
 *
 * A failure redirects back with the reason rather than returning it: a plain
 * form action returns void, and a refusal a staff member cannot see is a
 * refusal they will repeat.
 */

/** Redirects back to the lead with a message the staff member can act on. */
function fail(leadId: string, message: string): never {
  redirect(`/portal/leads/${leadId}?error=${encodeURIComponent(message)}`);
}

const statusSchema = z.object({
  leadId: z.string().uuid(),
  status: z.string().min(1).max(40),
  lostReason: z.string().max(300).optional(),
});

export async function changeStatusAction(formData: FormData): Promise<void> {
  const parsed = statusSchema.safeParse({
    leadId: formData.get('leadId'),
    status: formData.get('status'),
    lostReason: formData.get('lostReason') || undefined,
  });
  if (!parsed.success) redirect('/portal/leads');

  let problem: string | null = null;
  try {
    await withStaff('lead.status.write', (db, staff) =>
      changeStatus(db, staff, {
        leadId: parsed.data.leadId,
        status: parsed.data.status as LeadStatus,
        lostReason: parsed.data.lostReason,
      }),
    );
  } catch (error) {
    problem = toPublicError(error).message;
  }

  // Outside the try: redirect() signals by throwing, and catching it here
  // would swallow the navigation.
  if (problem) fail(parsed.data.leadId, problem);
  revalidatePath(`/portal/leads/${parsed.data.leadId}`);
}

export async function assignLeadAction(formData: FormData): Promise<void> {
  const leadId = z.string().uuid().safeParse(formData.get('leadId'));
  const raw = formData.get('staffId');
  const staffId = raw === '' || raw === null ? null : String(raw);

  if (!leadId.success) redirect('/portal/leads');
  if (staffId !== null && !z.string().uuid().safeParse(staffId).success) {
    fail(leadId.data, 'That staff member was not recognised.');
  }

  let problem: string | null = null;
  try {
    await withStaff('lead.assign', (db, staff) =>
      assignLead(db, staff, { leadId: leadId.data, staffId }),
    );
  } catch (error) {
    problem = toPublicError(error).message;
  }

  if (problem) fail(leadId.data, problem);
  revalidatePath(`/portal/leads/${leadId.data}`);
}

export async function addNoteAction(formData: FormData): Promise<void> {
  const leadId = String(formData.get('leadId') ?? '');
  const parsed = z
    .object({ leadId: z.string().uuid(), body: z.string().trim().min(1).max(2000) })
    .safeParse({ leadId, body: formData.get('body') });

  if (!parsed.success) fail(leadId, 'A note cannot be empty.');

  let problem: string | null = null;
  try {
    await withStaff('lead.note.write', (db, staff) => addStaffNote(db, staff, parsed.data));
  } catch (error) {
    problem = toPublicError(error).message;
  }

  if (problem) fail(parsed.data.leadId, problem);
  revalidatePath(`/portal/leads/${parsed.data.leadId}`);
}

export async function completeFollowUpAction(formData: FormData): Promise<void> {
  const parsed = z
    .object({
      taskId: z.string().uuid(),
      outcome: z.enum(['done', 'dismissed']),
      leadId: z.string().uuid(),
    })
    .safeParse({
      taskId: formData.get('taskId'),
      outcome: formData.get('outcome'),
      leadId: formData.get('leadId'),
    });

  if (!parsed.success) redirect('/portal');

  let problem: string | null = null;
  try {
    await withStaff('lead.status.write', (db, staff) =>
      completeFollowUp(db, parsed.data.taskId, staff.authUserId, parsed.data.outcome),
    );
  } catch (error) {
    problem = toPublicError(error).message;
  }

  if (problem) fail(parsed.data.leadId, problem);
  revalidatePath('/portal');
  revalidatePath(`/portal/leads/${parsed.data.leadId}`);
}
