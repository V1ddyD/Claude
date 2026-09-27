'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { withStaff } from '@/server/auth/require-staff';
import { markAppointmentDone, markLeadDone, reopenLead } from '@/server/services/leads/done';

/**
 * "Mark as done", "Reopen" and "Appointment done".
 *
 * Each re-authorises on the server and the service re-checks that this person
 * may work this lead: a button being on the page proves nothing. Where to go
 * afterwards is picked from a fixed list, never taken from the form as a URL.
 */

const id = z.string().uuid();
const BACK: Record<string, string> = { dashboard: '/portal', leads: '/portal/leads', appointments: '/portal/appointments' };

function refresh() {
  for (const path of ['/portal', '/portal/leads', '/portal/appointments']) revalidatePath(path);
}

export async function markLeadDoneAction(formData: FormData): Promise<void> {
  const leadId = id.safeParse(formData.get('leadId'));
  if (!leadId.success) return;
  await withStaff((db, staff) => markLeadDone(db, staff, leadId.data));
  refresh();
  revalidatePath(`/portal/leads/${leadId.data}`);
  const back = BACK[String(formData.get('back') ?? '')];
  if (back) redirect(back as '/portal');
}

export async function reopenLeadAction(formData: FormData): Promise<void> {
  const leadId = id.safeParse(formData.get('leadId'));
  if (!leadId.success) return;
  await withStaff((db, staff) => reopenLead(db, staff, leadId.data));
  refresh();
  revalidatePath(`/portal/leads/${leadId.data}`);
}

export async function markAppointmentDoneAction(formData: FormData): Promise<void> {
  const appointmentId = id.safeParse(formData.get('appointmentId'));
  if (!appointmentId.success) return;
  await withStaff((db, staff) => markAppointmentDone(db, staff, appointmentId.data));
  refresh();
}
