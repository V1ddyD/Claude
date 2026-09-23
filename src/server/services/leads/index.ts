import 'server-only';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  customers, leads, leadSignals, leadEvents, leadScoringRules, conversations,
  channelIdentities,
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
          // A returning customer who agrees to be contacted has agreed. This
          // used to be dropped: the update carried the name and the phone and
          // left consent as it was, so somebody who had once said no could
          // say yes, be booked in, and still not be sent their confirmation.
          // Only ever set, never cleared: withdrawing consent is its own act.
          ...(identity.contactConsent
            ? { contactConsent: true, consentAt: new Date(), consentSource: 'chat' }
            : {}),
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

/**
 * Tell the customer behind THIS conversation who they are.
 *
 * Every write tool needs a customer and a lead, and used to get them in two
 * independent steps: find or create a customer by email, then find or create
 * the conversation's lead. Independent is the problem. A direct message opens
 * a lead from the first message, against a placeholder customer that knows
 * only the Instagram handle — so when that person then booked a test drive and
 * gave their name, email and number, step one created a SECOND customer, step
 * two found the existing lead, and the lead stayed attached to the placeholder.
 * The portal showed "@handle", no email, no phone, for someone who had given
 * all three.
 *
 * So the conversation's own lead is the starting point:
 *
 *   no lead yet        the old behaviour: find or create by email, open a lead
 *   lead's customer    fill it in — this is the DM case, and the one that
 *     has no email     matters: the placeholder becomes the real person
 *     or the same one
 *   the email belongs  re-point the lead, the conversation and the channel
 *     to a customer    identity to that customer, so a returning customer is
 *     we already have  one record rather than two
 *   the lead's         somebody else's details in the same conversation. The
 *     customer has a   existing record is left alone — overwriting one
 *     different email  person's email with another's is the worst version of
 *                      this bug — and the new details get their own customer
 */
export async function identifyConversationCustomer(
  db: TenantDb,
  conversationId: string,
  identity: IdentityHints,
): Promise<{ customerId: string; leadId: string } | null> {
  const email = identity.email?.trim().toLowerCase() || null;
  const phone = identity.phone?.trim() || null;
  const fullName = identity.fullName?.trim() || null;
  if (!email && !phone && !fullName) return null;

  const lead = await findLeadForConversation(db, conversationId);

  if (!lead) {
    const customerId = await resolveCustomer(db, { ...identity, email, phone, fullName });
    if (!customerId) return null;
    const leadId = await upsertLead(db, { conversationId, customerId });
    await linkConversation(db, conversationId, customerId);
    return { customerId, leadId };
  }

  const [current] = await db
    .select({ id: customers.id, email: customers.email })
    .from(customers)
    .where(and(eq(customers.tenantId, db.tenantId), eq(customers.id, lead.customerId)))
    .limit(1);

  const other = email
    ? (
        await db
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.tenantId, db.tenantId), eq(customers.email, email)))
          .limit(1)
      )[0]
    : undefined;

  // A customer we already know by this email, and it is not the one on the
  // lead. Move the conversation across to them.
  if (other && other.id !== current?.id) {
    await db
      .update(customers)
      .set({
        ...(fullName ? { fullName } : {}),
        ...(phone ? { phone } : {}),
        ...(identity.contactConsent
          ? { contactConsent: true, consentAt: new Date(), consentSource: 'chat' }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(customers.tenantId, db.tenantId), eq(customers.id, other.id)));

    await repointLead(db, lead.id, current?.id ?? null, other.id, conversationId);
    return { customerId: other.id, leadId: lead.id };
  }

  const sameOrUnset = !current?.email || !email || current.email.toLowerCase() === email;

  if (current && sameOrUnset) {
    await db
      .update(customers)
      .set({
        ...(fullName ? { fullName } : {}),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(identity.contactConsent
          ? { contactConsent: true, consentAt: new Date(), consentSource: 'chat' }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(customers.tenantId, db.tenantId), eq(customers.id, current.id)));

    await linkConversation(db, conversationId, current.id);
    return { customerId: current.id, leadId: lead.id };
  }

  // A different person's details in this conversation. Recorded, and the
  // existing customer is not touched.
  const customerId = await resolveCustomer(db, { ...identity, email, phone, fullName });
  if (!customerId) return null;
  return { customerId, leadId: lead.id };
}

/** The conversation row carries its customer too, once there is one. */
async function linkConversation(db: TenantDb, conversationId: string, customerId: string) {
  await db
    .update(conversations)
    .set({ customerId })
    .where(and(eq(conversations.tenantId, db.tenantId), eq(conversations.id, conversationId)));
}

/**
 * Move a lead from a placeholder customer to the real one.
 *
 * The channel identity moves with it, which is what makes the NEXT message from
 * the same Instagram account arrive already attached to the right person
 * instead of opening another placeholder.
 */
async function repointLead(
  db: TenantDb,
  leadId: string,
  fromCustomerId: string | null,
  toCustomerId: string,
  conversationId: string,
) {
  await db
    .update(leads)
    .set({ customerId: toCustomerId })
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId)));

  await linkConversation(db, conversationId, toCustomerId);

  if (fromCustomerId) {
    await db
      .update(channelIdentities)
      .set({ customerId: toCustomerId })
      .where(
        and(
          eq(channelIdentities.tenantId, db.tenantId),
          eq(channelIdentities.customerId, fromCustomerId),
        ),
      );
  }

  await db.insert(leadEvents).values({
    tenantId: db.tenantId,
    leadId,
    type: 'customer_identified',
    actorType: 'customer',
    summary: 'Matched to an existing customer by email address.',
  });
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

  // The event and the audit row both describe the lead that now exists and
  // neither reads the other, so they go out together.
  await Promise.all([
    db.insert(leadEvents).values({
      tenantId: db.tenantId,
      leadId,
      type: 'created',
      actorType: 'ai',
      summary: 'Lead created from an assistant conversation.',
    }),
    recordAudit(db, {
      actor: { type: 'ai' },
      action: 'lead.created',
      entityType: 'lead',
      entityId: leadId,
      after: { customerId: params.customerId, conversationId: params.conversationId },
    }),
  ]);

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

  // Every field at once, not one field at a time.
  //
  // This used to supersede and insert per signal, so a message that told us
  // four things cost eight sequential statements. Superseding by `field IN
  // (...)` and inserting the replacements as one row set is two, and the
  // supersede-then-replace ordering that staff rely on is unchanged: the old
  // rows are all closed before any new row exists.
  const fields = flat.map((item) => item.field);

  await db
    .update(leadSignals)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(leadSignals.tenantId, db.tenantId),
        eq(leadSignals.leadId, leadId),
        inArray(leadSignals.field, fields),
        isNull(leadSignals.supersededAt),
      ),
    );

  // Denormalise the current best values onto the lead for querying. The signal
  // rows remain the record of how we know each one.
  const current = Object.fromEntries(flat.map((f) => [f.field, f.value]));

  await Promise.all([
    db.insert(leadSignals).values(
      flat.map((item) => ({
        tenantId: db.tenantId,
        leadId,
        field: item.field,
        value: item.value as never,
        confidence: String(item.confidence),
        source: options.source ?? 'ai',
        extractedFromMessageId: options.messageId ?? null,
      })),
    ),
    db
      .update(leads)
      .set({
        budgetCents: typeof current.budgetCents === 'number' ? current.budgetCents : undefined,
        purchaseTimeframe: typeof current.purchaseTimeframe === 'string' ? current.purchaseTimeframe : undefined,
        financeInterest: typeof current.financeInterest === 'boolean' ? current.financeInterest : undefined,
        tradeInInterest: typeof current.tradeInInterest === 'boolean' ? current.tradeInInterest : undefined,
        lastActivityAt: new Date(),
      })
      .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId))),
  ]);
}

export async function recomputePriority(
  db: TenantDb,
  leadId: string,
  bands: ScoreBands = DEFAULT_BANDS,
): Promise<{ priority: LeadPriority; score: number; rationale: string }> {
  // The evidence, the rules to judge it by, and the priority it currently has:
  // three reads that do not depend on each other, so one round trip.
  const [signalRows, rules, before] = await Promise.all([
    db
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
      ),
    loadRules(db),
    db
      .select({ priority: leads.priority, score: leads.score })
      .from(leads)
      .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId)))
      .limit(1),
  ]);

  const result = scoreLead(
    signalRows.map((r) => ({
      field: r.field,
      value: r.value,
      confidence: Number(r.confidence),
    })),
    rules,
    bands,
  );

  const changed = before[0] && before[0].priority !== result.priority;

  await Promise.all([
    db
      .update(leads)
      .set({
        priority: result.priority,
        score: result.score,
        scoreRationale: result.rationale,
        scoredAt: new Date(),
      })
      .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId))),
    ...(changed
      ? [
          db.insert(leadEvents).values({
            tenantId: db.tenantId,
            leadId,
            type: 'priority_changed' as const,
            actorType: 'system' as const,
            summary: `Priority ${before[0]!.priority} → ${result.priority}. ${result.rationale}`,
            payload: { firedRules: result.firedRules, score: result.score },
          }),
          recordAudit(db, {
            actor: { type: 'system' },
            action: 'lead.priority.changed',
            entityType: 'lead',
            entityId: leadId,
            before: { priority: before[0]!.priority, score: before[0]!.score },
            after: { priority: result.priority, score: result.score },
          }),
        ]
      : []),
  ]);

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
  await Promise.all([
    db.insert(leadEvents).values({
      tenantId: db.tenantId,
      leadId,
      type: event.type,
      actorType: event.actorType ?? 'system',
      summary: event.summary,
      payload: (event.payload ?? null) as never,
    }),
    db
      .update(leads)
      .set({ lastActivityAt: sql`now()` })
      .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId))),
  ]);
}
