import 'server-only';
import { and, eq, desc, isNull, or, inArray, sql } from 'drizzle-orm';
import {
  leads, leadEvents, leadSignals, customers, staffUsers, staffNotes,
  messages, appointments, tickets, vehicleModels,
} from '@/server/db/schema';
import type { TenantDb } from '@/server/db/tenant-db';
import type { StaffContext } from '@/server/auth/require-staff';

/**
 * Lead reads for the Dealer Portal.
 *
 * Row-level scoping lives here rather than in the guard: SALES holds
 * `lead.read.assigned`, a narrower version of the same capability, so the
 * filter is applied to the query rather than the permission being denied.
 */

function visibilityFilter(staff: StaffContext) {
  if (staff.can('lead.read.all')) return undefined;
  // A salesperson sees their own leads and anything unassigned — an unclaimed
  // lead nobody can see is a lead nobody calls.
  return or(eq(leads.assignedStaffId, staff.authUserId), isNull(leads.assignedStaffId));
}

export async function listLeads(db: TenantDb, staff: StaffContext, limit = 50) {
  const filter = visibilityFilter(staff);

  return db
    .select({
      id: leads.id,
      priority: leads.priority,
      score: leads.score,
      status: leads.status,
      customerName: customers.fullName,
      customerEmail: customers.email,
      budgetCents: leads.budgetCents,
      purchaseTimeframe: leads.purchaseTimeframe,
      aiSummary: leads.aiSummary,
      financeInterest: leads.financeInterest,
      tradeInInterest: leads.tradeInInterest,
      assignedTo: staffUsers.fullName,
      lastActivityAt: leads.lastActivityAt,
      createdAt: leads.createdAt,

      // What they are actually shopping for, and whether it is already in the
      // diary. Both are correlated subqueries rather than joins: a join on
      // signals would multiply the row per signal, and a second query would be
      // a second round trip for a column.
      //
      // The model arrives as the slug the catalogue accepted, so it is
      // resolved to the name staff use rather than shown as `s5`.
      //
      // The outer columns are written out rather than interpolated: a bare
      // `tenant_id` here is ambiguous against the joined tables, and a bare
      // `id` would bind to the subquery's own row instead of the lead's.
      wants: sql<string | null>`(
        SELECT vm.full_name
        FROM lead_signals ls
        JOIN vehicle_models vm
          ON vm.tenant_id = ls.tenant_id AND vm.slug = ls.value #>> '{}'
        WHERE ls.tenant_id = leads.tenant_id
          AND ls.lead_id = leads.id
          AND ls.field = 'modelSlug'
          AND ls.superseded_at IS NULL
        LIMIT 1
      )`,
      bookedAt: sql<Date | null>`(
        SELECT a.starts_at
        FROM appointments a
        WHERE a.tenant_id = leads.tenant_id
          AND a.lead_id = leads.id
          AND a.status IN ('scheduled', 'confirmed')
        ORDER BY a.starts_at
        LIMIT 1
      )`,
    })
    .from(leads)
    .innerJoin(customers, eq(customers.id, leads.customerId))
    .leftJoin(staffUsers, eq(staffUsers.id, leads.assignedStaffId))
    .where(and(eq(leads.tenantId, db.tenantId), ...(filter ? [filter] : [])))
    .orderBy(
      // Highest priority first, then most recently active: the order a
      // salesperson should work the list in.
      sql`case ${leads.priority} when 'high' then 0 when 'medium' then 1 else 2 end`,
      desc(leads.lastActivityAt),
    )
    .limit(limit);
}

export async function countByPriority(db: TenantDb, staff: StaffContext) {
  const filter = visibilityFilter(staff);

  const rows = await db
    .select({ priority: leads.priority, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(
      and(
        eq(leads.tenantId, db.tenantId),
        inArray(leads.status, ['new', 'contacted', 'qualified', 'appointment_scheduled', 'negotiating']),
        ...(filter ? [filter] : []),
      ),
    )
    .groupBy(leads.priority);

  return {
    high: rows.find((r) => r.priority === 'high')?.count ?? 0,
    medium: rows.find((r) => r.priority === 'medium')?.count ?? 0,
    low: rows.find((r) => r.priority === 'low')?.count ?? 0,
  };
}

export async function getLeadDetail(db: TenantDb, staff: StaffContext, leadId: string) {
  const filter = visibilityFilter(staff);

  const rows = await db
    .select({
      lead: leads,
      customer: customers,
      assignedTo: staffUsers.fullName,
    })
    .from(leads)
    .innerJoin(customers, eq(customers.id, leads.customerId))
    .leftJoin(staffUsers, eq(staffUsers.id, leads.assignedStaffId))
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId), ...(filter ? [filter] : [])))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const [signals, timeline, notes, transcript, appointmentRows, ticketRows, model] =
    await Promise.all([
      db
        .select({
          field: leadSignals.field,
          value: leadSignals.value,
          confidence: leadSignals.confidence,
          source: leadSignals.source,
          createdAt: leadSignals.createdAt,
        })
        .from(leadSignals)
        .where(
          and(
            eq(leadSignals.tenantId, db.tenantId),
            eq(leadSignals.leadId, leadId),
            isNull(leadSignals.supersededAt),
          ),
        ),

      db
        .select({
          type: leadEvents.type,
          summary: leadEvents.summary,
          actorType: leadEvents.actorType,
          createdAt: leadEvents.createdAt,
        })
        .from(leadEvents)
        .where(and(eq(leadEvents.tenantId, db.tenantId), eq(leadEvents.leadId, leadId)))
        .orderBy(desc(leadEvents.createdAt))
        .limit(50),

      db
        .select({
          body: staffNotes.body,
          author: staffUsers.fullName,
          createdAt: staffNotes.createdAt,
        })
        .from(staffNotes)
        .leftJoin(staffUsers, eq(staffUsers.id, staffNotes.authorId))
        .where(and(eq(staffNotes.tenantId, db.tenantId), eq(staffNotes.leadId, leadId)))
        .orderBy(desc(staffNotes.createdAt)),

      row.lead.conversationId
        ? db
            .select({
              role: messages.role,
              content: messages.content,
              toolName: messages.toolName,
              createdAt: messages.createdAt,
            })
            .from(messages)
            .where(
              and(
                eq(messages.tenantId, db.tenantId),
                eq(messages.conversationId, row.lead.conversationId),
              ),
            )
            .orderBy(messages.seq)
        : Promise.resolve([]),

      db
        .select({
          id: appointments.id,
          type: appointments.type,
          status: appointments.status,
          startsAt: appointments.startsAt,
          confirmationCode: appointments.confirmationCode,
        })
        .from(appointments)
        .where(and(eq(appointments.tenantId, db.tenantId), eq(appointments.leadId, leadId))),

      db
        .select({ number: tickets.number, type: tickets.type, status: tickets.status })
        .from(tickets)
        .where(and(eq(tickets.tenantId, db.tenantId), eq(tickets.leadId, leadId))),

      row.lead.modelId
        ? db
            .select({ fullName: vehicleModels.fullName })
            .from(vehicleModels)
            .where(
              and(eq(vehicleModels.tenantId, db.tenantId), eq(vehicleModels.id, row.lead.modelId)),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);

  return {
    lead: row.lead,
    customer: row.customer,
    assignedTo: row.assignedTo,
    modelName: model[0]?.fullName ?? null,
    signals,
    timeline,
    notes,
    transcript,
    appointments: appointmentRows,
    tickets: ticketRows,
  };
}
