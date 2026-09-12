import 'server-only';
import { and, eq, desc, isNull } from 'drizzle-orm';
import { messages, leads, leadSignals, conversations } from '@/server/db/schema';
import type { TenantDb } from '@/server/db/tenant-db';

/**
 * Pinned facts (spec §49).
 *
 * A customer who says "I want the S5" and then asks "how much is the Premium?"
 * means the S5 Premium. Replaying the whole transcript to recover that is
 * expensive and unreliable; carrying the established facts as a short block is
 * cheap and exact.
 *
 * Two sources, both structured rather than re-read from prose:
 *
 *   the current subject — the vehicle the last few tool calls were about
 *   the lead's signals  — what the customer has actually told us
 *
 * Deliberately NOT pinned: anything internal (priority, score, summary), and
 * anything sensitive that merely appeared in passing. Spec §49 warns against
 * persisting information just because it was said once.
 */

export interface PinnedFacts {
  facts: string[];
  subject: { modelSlug?: string; trimCode?: string; powertrainCode?: string };
  /** A compact record of earlier turns, for conversations past the replay window. */
  earlier: string | null;
}

/** Fields worth carrying forward. Everything else is noise in a prompt. */
const CARRIED: Record<string, (value: unknown) => string | null> = {
  modelSlug: (v) => `Interested in the ${String(v).toUpperCase()}`,
  trimCode: (v) => `Trim discussed: ${v}`,
  powertrainCode: (v) => `Powertrain discussed: ${v}`,
  exteriorColourCode: (v) => `Colour discussed: ${v}`,
  budgetCents: (v) =>
    typeof v === 'number' ? `Budget around ${Math.round(v / 100).toLocaleString()}` : null,
  purchaseTimeframe: (v) =>
    v === 'unknown' ? null : `Buying timeframe: ${String(v).replace(/_/g, ' ')}`,
  financeInterest: (v) => (v ? 'Interested in financing' : null),
  tradeInInterest: (v) => (v ? 'Has a vehicle to trade in' : null),
  customerName: (v) => `Their name is ${v}`,
  // Email and phone are deliberately absent: the assistant has no reason to
  // repeat them back, and a prompt is the wrong place to carry contact details.
};

/**
 * Three independent reads, issued together.
 *
 * They are not awaited one at a time: the driver pipelines statements that are
 * in flight at once, so this costs one network round trip rather than three.
 * On a deployment whose database is a continent away that is the difference
 * between a turn that answers and a turn that times out.
 *
 * The signals read joins through `leads` for the same reason — finding the
 * lead id first and then its signals is two round trips to answer one
 * question.
 */
export async function buildPinnedFacts(
  db: TenantDb,
  conversationId: string,
): Promise<PinnedFacts> {
  const [subject, [conversation], signals] = await Promise.all([
    findCurrentSubject(db, conversationId),
    db
      .select({ rollingSummary: conversations.rollingSummary })
      .from(conversations)
      .where(and(eq(conversations.tenantId, db.tenantId), eq(conversations.id, conversationId)))
      .limit(1),
    db
      .select({ field: leadSignals.field, value: leadSignals.value })
      .from(leadSignals)
      .innerJoin(
        leads,
        and(eq(leads.id, leadSignals.leadId), eq(leads.tenantId, leadSignals.tenantId)),
      )
      .where(
        and(
          eq(leadSignals.tenantId, db.tenantId),
          eq(leads.conversationId, conversationId),
          isNull(leadSignals.supersededAt),
        ),
      ),
  ]);

  const facts: string[] = [];
  const seen = new Set<string>();

  for (const signal of signals) {
    const render = CARRIED[signal.field];
    if (!render) continue;
    const text = render(signal.value);
    if (text && !seen.has(text)) {
      seen.add(text);
      facts.push(text);
    }
  }

  // The subject of the last few tool calls, which may be ahead of the lead —
  // a customer can browse three models before giving their name.
  if (subject.modelSlug && !facts.some((f) => f.includes(subject.modelSlug!.toUpperCase()))) {
    facts.unshift(`Currently looking at the ${subject.modelSlug.toUpperCase()}`);
  }

  return { facts, subject, earlier: conversation?.rollingSummary ?? null };
}

/**
 * The vehicle the conversation is currently about.
 *
 * Read from recent tool INPUTS rather than from what the customer typed: a tool
 * input is a resolved slug the catalogue accepted, so it cannot carry a
 * misheard or invented model name into the next turn.
 */
async function findCurrentSubject(
  db: TenantDb,
  conversationId: string,
): Promise<PinnedFacts['subject']> {
  const rows = await db
    .select({ toolInput: messages.toolInput })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, db.tenantId),
        eq(messages.conversationId, conversationId),
        eq(messages.role, 'tool'),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(8);

  const subject: PinnedFacts['subject'] = {};

  for (const row of rows) {
    const input = row.toolInput as Record<string, unknown> | null;
    if (!input) continue;
    // Most recent wins: iterating newest-first and only filling blanks means a
    // customer switching from the S5 to the E5 is followed, not averaged.
    if (!subject.modelSlug && typeof input.modelSlug === 'string') {
      subject.modelSlug = input.modelSlug;
    }
    if (!subject.trimCode && typeof input.trimCode === 'string') {
      subject.trimCode = input.trimCode;
    }
    if (!subject.powertrainCode && typeof input.powertrainCode === 'string') {
      subject.powertrainCode = input.powertrainCode;
    }
  }

  return subject;
}
