import 'server-only';
import { and, eq, or, isNull, lt, gte, lte, inArray } from 'drizzle-orm';
import {
  leads, leadEvents, followUpTasks, followUpRules, appointments, tickets, notifications,
} from '@/server/db/schema';
import { withTenant, type TenantDb } from '@/server/db/tenant-db';
import { DEFAULT_FOLLOW_UP_RULES, type FollowUpRule } from './rules';

/**
 * Evaluating follow-ups.
 *
 * Idempotent by construction: tasks are keyed on
 * (tenant, lead, rule, due_at), so re-running produces no duplicates. A worker
 * that ran twice must not nag a salesperson twice.
 */

export interface FollowUpReport {
  created: number;
  byRule: Record<string, number>;
}

export async function evaluateFollowUps(tenantId: string, now = new Date()): Promise<FollowUpReport> {
  return withTenant(tenantId, async (db) => {
    const rules = await loadRules(db);
    const report: FollowUpReport = { created: 0, byRule: {} };

    const record = async (
      rule: FollowUpRule,
      rows: { leadId: string; reason: string; dueAt: Date; appointmentId?: string }[],
    ) => {
      for (const row of rows) {
        const inserted = await db
          .insert(followUpTasks)
          .values({
            tenantId: db.tenantId,
            leadId: row.leadId,
            appointmentId: row.appointmentId ?? null,
            ruleKey: rule.key,
            reason: row.reason,
            recommendedAction: rule.recommendedAction,
            dueAt: row.dueAt,
          })
          .onConflictDoNothing()
          .returning({ id: followUpTasks.id });

        if (inserted[0]) {
          report.created++;
          report.byRule[rule.key] = (report.byRule[rule.key] ?? 0) + 1;

          await db.insert(leadEvents).values({
            tenantId: db.tenantId,
            leadId: row.leadId,
            type: 'follow_up_due',
            actorType: 'system',
            summary: `${rule.description}. ${rule.recommendedAction}.`,
          });
        }
      }
    };

    for (const rule of rules) {
      const cutoff = new Date(now.getTime() - rule.delayMinutes * 60_000);

      switch (rule.key) {
        case 'high_priority_untouched': {
          const rows = await db
            .select({ id: leads.id, createdAt: leads.createdAt })
            .from(leads)
            .where(
              and(
                eq(leads.tenantId, db.tenantId),
                eq(leads.priority, 'high'),
                eq(leads.status, 'new'),
                lt(leads.createdAt, cutoff),
              ),
            )
            .limit(100);

          await record(
            rule,
            rows.map((row) => ({
              leadId: row.id,
              reason: rule.description,
              // Bucketed to the hour so a task is stable across runs rather
              // than a new one appearing every minute.
              dueAt: truncateToHour(now),
            })),
          );
          break;
        }

        case 'callback_requested':
        case 'handoff_requested': {
          const type = rule.key === 'callback_requested' ? 'callback' : 'sales_enquiry';
          const rows = await db
            .select({ leadId: tickets.leadId })
            .from(tickets)
            .where(
              and(
                eq(tickets.tenantId, db.tenantId),
                eq(tickets.type, type),
                eq(tickets.status, 'open'),
                lt(tickets.createdAt, cutoff),
              ),
            )
            .limit(100);

          await record(
            rule,
            rows
              .filter((row): row is { leadId: string } => Boolean(row.leadId))
              .map((row) => ({
                leadId: row.leadId,
                reason: rule.description,
                dueAt: truncateToHour(now),
              })),
          );
          break;
        }

        case 'test_drive_tomorrow': {
          const from = new Date(now.getTime() + 12 * 3600_000);
          const to = new Date(now.getTime() + 36 * 3600_000);

          const rows = await db
            .select({
              id: appointments.id,
              leadId: appointments.leadId,
              startsAt: appointments.startsAt,
            })
            .from(appointments)
            .where(
              and(
                eq(appointments.tenantId, db.tenantId),
                eq(appointments.type, 'test_drive'),
                inArray(appointments.status, ['scheduled', 'confirmed']),
                gte(appointments.startsAt, from),
                lte(appointments.startsAt, to),
              ),
            )
            .limit(100);

          await record(
            rule,
            rows
              .filter((row): row is typeof row & { leadId: string } => Boolean(row.leadId))
              .map((row) => ({
                leadId: row.leadId,
                appointmentId: row.id,
                reason: rule.description,
                dueAt: new Date(row.startsAt.getTime() - 24 * 3600_000),
              })),
          );
          break;
        }

        case 'lead_dormant': {
          const rows = await db
            .select({ id: leads.id })
            .from(leads)
            .where(
              and(
                eq(leads.tenantId, db.tenantId),
                inArray(leads.status, ['new', 'contacted', 'qualified', 'negotiating']),
                lt(leads.lastActivityAt, cutoff),
              ),
            )
            .limit(100);

          await record(
            rule,
            rows.map((row) => ({
              leadId: row.id,
              reason: rule.description,
              dueAt: truncateToHour(now),
            })),
          );
          break;
        }
      }
    }

    // One notification for the batch, not one per task: spec §53 is explicit
    // that staff must not be spammed.
    if (report.created > 0) {
      await db.insert(notifications).values({
        tenantId: db.tenantId,
        roleTarget: 'sales',
        type: 'follow_ups_due',
        title: `${report.created} follow-up${report.created === 1 ? '' : 's'} due`,
        body: Object.entries(report.byRule)
          .map(([key, count]) => `${count} × ${key.replace(/_/g, ' ')}`)
          .join(', '),
        linkPath: '/portal/leads',
      });
    }

    return report;
  });
}

export async function listDueFollowUps(db: TenantDb, staffId: string, seesAll: boolean) {
  return db
    .select({
      id: followUpTasks.id,
      leadId: followUpTasks.leadId,
      reason: followUpTasks.reason,
      recommendedAction: followUpTasks.recommendedAction,
      dueAt: followUpTasks.dueAt,
      ruleKey: followUpTasks.ruleKey,
    })
    .from(followUpTasks)
    .innerJoin(leads, eq(leads.id, followUpTasks.leadId))
    .where(
      and(
        eq(followUpTasks.tenantId, db.tenantId),
        eq(followUpTasks.status, 'pending'),
        lte(followUpTasks.dueAt, new Date()),
        ...(seesAll
          ? []
          : [or(eq(leads.assignedStaffId, staffId), isNull(leads.assignedStaffId))!]),
      ),
    )
    .orderBy(followUpTasks.dueAt)
    .limit(50);
}

export async function completeFollowUp(
  db: TenantDb,
  taskId: string,
  staffId: string,
  outcome: 'done' | 'dismissed',
): Promise<void> {
  await db
    .update(followUpTasks)
    .set({ status: outcome, completedBy: staffId, completedAt: new Date() })
    .where(and(eq(followUpTasks.tenantId, db.tenantId), eq(followUpTasks.id, taskId)));
}

async function loadRules(db: TenantDb): Promise<FollowUpRule[]> {
  const rows = await db
    .select()
    .from(followUpRules)
    .where(and(eq(followUpRules.tenantId, db.tenantId), eq(followUpRules.isActive, true)));

  if (rows.length === 0) return DEFAULT_FOLLOW_UP_RULES;

  return rows.map((row) => ({
    key: row.key,
    description: row.description,
    recommendedAction: row.recommendedAction,
    delayMinutes: row.delayMinutes,
    businessHoursOnly: row.businessHoursOnly,
  }));
}

function truncateToHour(date: Date): Date {
  const copy = new Date(date);
  copy.setMinutes(0, 0, 0);
  return copy;
}

export { DEFAULT_FOLLOW_UP_RULES } from './rules';
export type { FollowUpRule } from './rules';
