import 'server-only';
import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { appointments, followUpTasks, leads, messages } from '@/server/db/schema';
import type { TenantDb } from '@/server/db/tenant-db';
import type { StaffContext } from '@/server/auth/require-staff';
import { recordAudit } from '@/server/services/audit';
import { forbidden, notFound } from '@/server/errors';
import { recordLeadEvent } from './index';

/**
 * "Done": this customer has been taken care of.
 *
 * Marking a lead done takes it out of every to-do list: the priority counts,
 * "worth a call now", unassigned, and follow-ups. Its pending follow-ups are
 * closed, and any appointment of theirs that has already happened is marked
 * completed. An appointment still to come stays in the calendar: a booked
 * test drive is still going to happen.
 *
 * Nothing is deleted. A done lead is one click from coming back, and comes
 * back by itself if the customer writes again.
 */

async function visibleLead(db: TenantDb, staff: StaffContext, leadId: string) {
  const [lead] = await db
    .select({ id: leads.id, assignedStaffId: leads.assignedStaffId, doneAt: leads.doneAt })
    .from(leads)
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId)))
    .limit(1);
  if (!lead) throw notFound('That lead');
  // A salesperson works their own leads and unassigned ones; a manager works anyone's.
  if (!staff.can('lead.read.all') && lead.assignedStaffId && lead.assignedStaffId !== staff.authUserId) {
    throw forbidden({ leadId, assignedTo: lead.assignedStaffId });
  }
  return lead;
}

export async function markLeadDone(db: TenantDb, staff: StaffContext, leadId: string): Promise<void> {
  staff.assert('lead.status.write');
  const lead = await visibleLead(db, staff, leadId);
  if (lead.doneAt) return;

  const now = new Date();
  await db
    .update(leads)
    .set({ doneAt: now, doneBy: staff.authUserId, lastActivityAt: now })
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId)));

  // Nothing left to chase.
  await db
    .update(followUpTasks)
    .set({ status: 'done', completedBy: staff.authUserId, completedAt: now })
    .where(
      and(
        eq(followUpTasks.tenantId, db.tenantId),
        eq(followUpTasks.leadId, leadId),
        eq(followUpTasks.status, 'pending'),
      ),
    );

  // Appointments that have already happened are finished with; ones still to
  // come are left alone.
  await db
    .update(appointments)
    .set({ status: 'completed' })
    .where(
      and(
        eq(appointments.tenantId, db.tenantId),
        eq(appointments.leadId, leadId),
        inArray(appointments.status, ['scheduled', 'confirmed']),
        lte(appointments.startsAt, now),
      ),
    );

  await recordLeadEvent(db, leadId, {
    type: 'status_changed',
    actorType: 'staff',
    summary: `${staff.fullName} marked this as done.`,
  });
  await recordAudit(db, {
    actor: { type: 'staff', id: staff.authUserId },
    action: 'lead.done',
    entityType: 'lead',
    entityId: leadId,
  });
}

export async function reopenLead(db: TenantDb, staff: StaffContext, leadId: string): Promise<void> {
  staff.assert('lead.status.write');
  const lead = await visibleLead(db, staff, leadId);
  if (!lead.doneAt) return;

  await db
    .update(leads)
    .set({ doneAt: null, doneBy: null, lastActivityAt: new Date() })
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId)));
  await recordLeadEvent(db, leadId, {
    type: 'status_changed',
    actorType: 'staff',
    summary: `${staff.fullName} reopened this.`,
  });
  await recordAudit(db, {
    actor: { type: 'staff', id: staff.authUserId },
    action: 'lead.reopened',
    entityType: 'lead',
    entityId: leadId,
  });
}

/**
 * A customer who was marked done has written again: back on the list.
 *
 * Called by the job that reads each new turn of a conversation. Reopens only
 * when there is a customer message newer than the moment it was marked done,
 * so re-reading an old conversation does not undo somebody's decision.
 */
export async function reopenIfCustomerReturned(db: TenantDb, leadId: string, conversationId: string): Promise<boolean> {
  const reopened = await db
    .update(leads)
    .set({ doneAt: null, doneBy: null })
    .where(
      and(
        eq(leads.tenantId, db.tenantId),
        eq(leads.id, leadId),
        isNotNull(leads.doneAt),
        sql`EXISTS (
          SELECT 1 FROM ${messages}
          WHERE ${messages.tenantId} = ${db.tenantId}
            AND ${messages.conversationId} = ${conversationId}
            AND ${messages.role} = 'user'
            AND ${messages.createdAt} > leads.done_at
        )`,
      ),
    )
    .returning({ id: leads.id });
  if (reopened.length === 0) return false;
  await recordLeadEvent(db, leadId, {
    type: 'status_changed',
    actorType: 'system',
    summary: 'The customer got in touch again, so this is back on the list.',
  });
  return true;
}

export async function markAppointmentDone(db: TenantDb, staff: StaffContext, appointmentId: string): Promise<void> {
  staff.assert('appointment.write');
  const [appointment] = await db
    .select({ id: appointments.id, leadId: appointments.leadId, status: appointments.status })
    .from(appointments)
    .where(and(eq(appointments.tenantId, db.tenantId), eq(appointments.id, appointmentId)))
    .limit(1);
  if (!appointment) throw notFound('That appointment');
  if (appointment.status !== 'scheduled' && appointment.status !== 'confirmed') return;

  await db
    .update(appointments)
    .set({ status: 'completed' })
    .where(and(eq(appointments.tenantId, db.tenantId), eq(appointments.id, appointmentId)));
  if (appointment.leadId) {
    await recordLeadEvent(db, appointment.leadId, {
      type: 'status_changed',
      actorType: 'staff',
      summary: `${staff.fullName} marked the appointment as done.`,
    });
  }
  await recordAudit(db, {
    actor: { type: 'staff', id: staff.authUserId },
    action: 'appointment.completed',
    entityType: 'appointment',
    entityId: appointmentId,
  });
}

/** For the to-do queries: a lead still needing someone. */
export const notDone = isNull(leads.doneAt);
