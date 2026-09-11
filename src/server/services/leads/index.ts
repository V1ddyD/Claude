import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  customers, leads, leadSignals, leadEvents, leadScoringRules,
  type LeadPriority,
} from '@/server/db/schema';
import type { TenantDb } from '@/server/db/tenant-db';
import { recordAudit } from '@/server/services/audit';
import {
  scoreLead, DEFAULT_SCORING_RULES, DEFAULT_BANDS,
  type ScoringRule, type ScoreBands, type Condition,
} from '@/server/services/scoring/rules';
import { flattenSignals, type LeadSignals } from '@/server/services/scoring/signals';

/**
 * Lead lifecycle.
 *
 * One lead per conversation: a customer who asks three questions is one person
 * with one intent, not three leads. docs/04-spec-review.md §4 — a lead is the
 * sales relationship, a ticket is the individual request.
 */

export interface IdentityHints {
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  contactConsent?: boolean;
}

/**
 * Find or create the customer behind a conversation.
 *
 * Matching is by email within the tenant. Note what this is NOT: a lookup that
 * lets a caller retrieve someone's record by typing their address. It only ever
 * attaches the current conversation to a row, and returns no stored data.
 */
export async function resolveCustomer(
  db: TenantDb,
  identity: IdentityHints,
): Promise<string | null> {
  const email = identity.email?.trim().toLowerCase();
  const phone = identity.phone?.trim();

  if (!email && !phone && !identity.fullName) return null;

  if (email) {
    const existing = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.tenantId, db.tenantId), eq(customers.email, email)))
      .limit(1);

    if (existing[0]) {
      await db
        .update(customers)
        .set({
          fullName: identity.fullName ?? undefined,
          phone: phone ?? undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(customers.tenantId, db.tenantId), eq(customers.id, existing[0].id)));
      return existing[0].id;
    }
  }

  const created = await db
    .insert(customers)
    .values({
      tenantId: db.tenantId,
      fullName: identity.fullName ?? null,
      email: email ?? null,
      phone: phone ?? null,
      contactConsent: identity.contactConsent ?? false,
      consentSource: 'chat',
      consentAt: identity.contactConsent ? new Date() : null,
    })
    .returning({ id: customers.id });

  return created[0]!.id;
}

export async function findLeadForConversation(db: TenantDb, conversationId: string) {
  const rows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.conversationId, conversationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertLead(
  db: TenantDb,
  params: { conversationId: string; customerId: string; source?: string },
): Promise<string> {
  const existing = await findLeadForConversation(db, params.conversationId);
  if (existing) return existing.id;

  const created = await db
    .insert(leads)
    .values({
      tenantId: db.tenantId,
      customerId: params.customerId,
      conversationId: params.conversationId,
      source: params.source ?? 'ai_assistant',
    })
    .returning({ id: leads.id });

  const leadId = created[0]!.id;

  await db.insert(leadEvents).values({
    tenantId: db.tenantId,
    leadId,
    type: 'created',
    actorType: 'ai',
    summary: 'Lead created from an assistant conversation.',
  });
  await recordAudit(db, {
    actor: { type: 'ai' },
    action: 'lead.created',
    entityType: 'lead',
    entityId: leadId,
    after: { customerId: params.customerId, conversationId: params.conversationId },
  });

  return leadId;
}

/**
 * Record extracted evidence, then recompute priority from it.
 *
 * Signals supersede rather than overwrite: a corrected budget leaves the
 * original in place with a `superseded_at`, so staff can see that it changed
 * and when, rather than a number that silently became a different number.
 */
export async function applySignals(
  db: TenantDb,
  leadId: string,
  signals: LeadSignals,
  options: { messageId?: string; source?: 'ai' | 'form' | 'staff' } = {},
): Promise<void> {
  const flat = flattenSignals(signals);
  if (flat.length === 0) return;

  for (const item of flat) {
    await db
      .update(leadSignals)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(leadSignals.tenantId, db.tenantId),
          eq(leadSignals.leadId, leadId),
          eq(leadSignals.field, item.field),
          isNull(leadSignals.supersededAt),
        ),
      );

    await db.insert(leadSignals).values({
      tenantId: db.tenantId,
      leadId,
      field: item.field,
      value: item.value as never,
      confidence: String(item.confidence),
      source: options.source ?? 'ai',
      extractedFromMessageId: options.messageId ?? null,
    });
  }

  // Denormalise the current best values onto the lead for querying. The signal
  // rows remain the record of how we know each one.
  const current = Object.fromEntries(flat.map((f) => [f.field, f.value]));
  await db
    .update(leads)
    .set({
      budgetCents: typeof current.budgetCents === 'number' ? current.budgetCents : undefined,
      purchaseTimeframe: typeof current.purchaseTimeframe === 'string' ? current.purchaseTimeframe : undefined,
      financeInterest: typeof current.financeInterest === 'boolean' ? current.financeInterest : undefined,
      tradeInInterest: typeof current.tradeInInterest === 'boolean' ? current.tradeInInterest : undefined,
      lastActivityAt: new Date(),
    })
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId)));
}

export async function recomputePriority(
  db: TenantDb,
  leadId: string,
  bands: ScoreBands = DEFAULT_BANDS,
): Promise<{ priority: LeadPriority; score: number; rationale: string }> {
  const signalRows = await db
    .select({
      field: leadSignals.field,
      value: leadSignals.value,
      confidence: leadSignals.confidence,
    })
    .from(leadSignals)
    .where(
      and(
        eq(leadSignals.tenantId, db.tenantId),
        eq(leadSignals.leadId, leadId),
        isNull(leadSignals.supersededAt),
      ),
    );

  const rules = await loadRules(db);
  const result = scoreLead(
    signalRows.map((r) => ({
      field: r.field,
      value: r.value,
      confidence: Number(r.confidence),
    })),
    rules,
    bands,
  );

  const before = await db
    .select({ priority: leads.priority, score: leads.score })
    .from(leads)
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId)))
    .limit(1);

  await db
    .update(leads)
    .set({
      priority: result.priority,
      score: result.score,
      scoreRationale: result.rationale,
      scoredAt: new Date(),
    })
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId)));

  if (before[0] && before[0].priority !== result.priority) {
    await db.insert(leadEvents).values({
      tenantId: db.tenantId,
      leadId,
      type: 'priority_changed',
      actorType: 'system',
      summary: `Priority ${before[0].priority} → ${result.priority}. ${result.rationale}`,
      payload: { firedRules: result.firedRules, score: result.score },
    });
    await recordAudit(db, {
      actor: { type: 'system' },
      action: 'lead.priority.changed',
      entityType: 'lead',
      entityId: leadId,
      before: { priority: before[0].priority, score: before[0].score },
      after: { priority: result.priority, score: result.score },
    });
  }

  return result;
}

/** Tenant rules if configured, otherwise the product defaults. */
async function loadRules(db: TenantDb): Promise<ScoringRule[]> {
  const rows = await db
    .select()
    .from(leadScoringRules)
    .where(and(eq(leadScoringRules.tenantId, db.tenantId), eq(leadScoringRules.isActive, true)));

  if (rows.length === 0) return DEFAULT_SCORING_RULES;

  return rows.map((row) => ({
    key: row.key,
    description: row.description,
    condition: row.condition as Condition,
    weight: row.weight,
    minConfidence: Number(row.minConfidence),
    supersedes: DEFAULT_SCORING_RULES.find((r) => r.key === row.key)?.supersedes,
  }));
}

export async function recordLeadEvent(
  db: TenantDb,
  leadId: string,
  event: { type: string; summary: string; actorType?: 'customer' | 'staff' | 'system' | 'ai'; payload?: unknown },
): Promise<void> {
  await db.insert(leadEvents).values({
    tenantId: db.tenantId,
    leadId,
    type: event.type,
    actorType: event.actorType ?? 'system',
    summary: event.summary,
    payload: (event.payload ?? null) as never,
  });
  await db
    .update(leads)
    .set({ lastActivityAt: sql`now()` })
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId)));
}
