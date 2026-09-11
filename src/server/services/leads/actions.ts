import 'server-only';
import { and, eq } from 'drizzle-orm';
import { leads, staffUsers, staffNotes, type LeadStatus } from '@/server/db/schema';
import type { TenantDb } from '@/server/db/tenant-db';
import type { StaffContext } from '@/server/auth/require-staff';
import { recordAudit, changedFields } from '@/server/services/audit';
import { recordLeadEvent } from './index';
import { forbidden, notFound, AppError } from '@/server/errors';

/**
 * Staff actions on a lead.
 *
 * Priority is computed and never set by hand; STATUS is the opposite — it is
 * owned by a person, and the system only records who changed it and when
 * (spec §12). That asymmetry is the point: the machine judges intent, the
 * human judges the relationship.
 */

/** Transitions a person may make. Won and Lost are terminal. */
const ALLOWED_STATUS: Record<LeadStatus, LeadStatus[]> = {
  new: ['contacted', 'qualified', 'lost', 'nurture'],
  contacted: ['qualified', 'appointment_scheduled', 'lost', 'nurture'],
  qualified: ['appointment_scheduled', 'proposal_sent', 'negotiating', 'lost', 'nurture'],
  appointment_scheduled: ['test_drive_completed', 'contacted', 'lost', 'nurture'],
  test_drive_completed: ['proposal_sent', 'negotiating', 'won', 'lost', 'nurture'],
  proposal_sent: ['negotiating', 'won', 'lost', 'nurture'],
  negotiating: ['won', 'lost', 'proposal_sent', 'nurture'],
  nurture: ['contacted', 'qualified', 'lost'],
  won: [],
  lost: ['nurture'],
};

export function allowedNextStatuses(current: LeadStatus): LeadStatus[] {
  return ALLOWED_STATUS[current] ?? [];
}

export async function changeStatus(
  db: TenantDb,
  staff: StaffContext,
  params: { leadId: string; status: LeadStatus; lostReason?: string },
): Promise<void> {
  staff.assert('lead.status.write');

  const rows = await db
    .select({ status: leads.status, assignedStaffId: leads.assignedStaffId })
    .from(leads)
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, params.leadId)))
    .limit(1);

  const lead = rows[0];
  if (!lead) throw notFound('That lead');

  if (!allowedNextStatuses(lead.status).includes(params.status)) {
    throw new AppError(
      'CONFLICT',
      `A lead that is "${lead.status.replace(/_/g, ' ')}" cannot move to ` +
        `"${params.status.replace(/_/g, ' ')}".`,
      { data: { from: lead.status, allowed: allowedNextStatuses(lead.status) } },
    );
  }

  // A salesperson works their own leads; a manager works anyone's.
  if (!staff.can('lead.read.all') && lead.assignedStaffId && lead.assignedStaffId !== staff.authUserId) {
    throw forbidden({ leadId: params.leadId, assignedTo: lead.assignedStaffId });
  }

  const closing = params.status === 'won' || params.status === 'lost';

  await db
    .update(leads)
    .set({
      status: params.status,
      lostReason: params.status === 'lost' ? (params.lostReason ?? null) : null,
      closedAt: closing ? new Date() : null,
      lastActivityAt: new Date(),
    })
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, params.leadId)));

  await recordLeadEvent(db, params.leadId, {
    type: 'status_changed',
    actorType: 'staff',
    summary:
      `${staff.fullName} moved this from ${lead.status.replace(/_/g, ' ')} to ` +
      `${params.status.replace(/_/g, ' ')}` +
      (params.lostReason ? ` — ${params.lostReason}` : '') +
      '.',
  });

  await recordAudit(db, {
    actor: { type: 'staff', id: staff.authUserId },
    action: 'lead.status.changed',
    entityType: 'lead',
    entityId: params.leadId,
    ...(changedFields({ status: lead.status }, { status: params.status }) ?? {}),
  });
}

export async function assignLead(
  db: TenantDb,
  staff: StaffContext,
  params: { leadId: string; staffId: string | null },
): Promise<void> {
  staff.assert('lead.assign');

  const [lead] = await db
    .select({ assignedStaffId: leads.assignedStaffId })
    .from(leads)
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, params.leadId)))
    .limit(1);
  if (!lead) throw notFound('That lead');

  let assigneeName = 'nobody';
  if (params.staffId) {
    // The assignee must be active staff IN THIS TENANT — verified by query,
    // not assumed from the form, which is untrusted input.
    const [assignee] = await db
      .select({ fullName: staffUsers.fullName })
      .from(staffUsers)
      .where(
        and(
          eq(staffUsers.tenantId, db.tenantId),
          eq(staffUsers.id, params.staffId),
          eq(staffUsers.status, 'active'),
        ),
      )
      .limit(1);
    if (!assignee) throw notFound('That staff member');
    assigneeName = assignee.fullName;
  }

  await db
    .update(leads)
    .set({
      assignedStaffId: params.staffId,
      assignedAt: params.staffId ? new Date() : null,
      lastActivityAt: new Date(),
    })
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, params.leadId)));

  await recordLeadEvent(db, params.leadId, {
    type: 'assigned',
    actorType: 'staff',
    summary: `${staff.fullName} assigned this to ${assigneeName}.`,
  });

  await recordAudit(db, {
    actor: { type: 'staff', id: staff.authUserId },
    action: 'lead.assigned',
    entityType: 'lead',
    entityId: params.leadId,
    before: { assignedStaffId: lead.assignedStaffId },
    after: { assignedStaffId: params.staffId },
  });
}

/** Internal only. Customers never see these (spec §27). */
export async function addStaffNote(
  db: TenantDb,
  staff: StaffContext,
  params: { leadId: string; body: string },
): Promise<void> {
  staff.assert('lead.note.write');

  const body = params.body.trim();
  if (body.length === 0) throw new AppError('VALIDATION_FAILED', 'A note cannot be empty.');

  await db.insert(staffNotes).values({
    tenantId: db.tenantId,
    leadId: params.leadId,
    authorId: staff.authUserId,
    body,
  });

  await recordAudit(db, {
    actor: { type: 'staff', id: staff.authUserId },
    action: 'lead.note.added',
    entityType: 'lead',
    entityId: params.leadId,
  });
}
