import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { and, eq, asc } from 'drizzle-orm';
import { messages as messagesTable, conversations, leads } from '@/server/db/schema';
import { withTenant, type TenantDb } from '@/server/db/tenant-db';
import { modelClient, EXTRACTION_MODEL, type ModelClient } from '@/server/ai/client';
import { RuleBasedModel } from '@/server/ai/rule-based';
import { extractSignals, type ResolvedBuild } from '@/server/ai/rule-based/signals';
import { remember } from '@/server/ai/rule-based';
import {
  resolveTrim, resolvePowertrain, resolveColour,
} from '@/server/ai/rule-based/resolve';
import { vehicleModels, trims, powertrains, colours } from '@/server/db/schema';
import { EXTRACTION_SYSTEM_PROMPT } from '@/server/ai/prompts/system';
import { leadSignalsSchema, type LeadSignals } from '@/server/services/scoring/signals';
import { applySignals, recomputePriority, findLeadForConversation } from '@/server/services/leads';
import { ensureVisitor } from '@/server/services/visitors';

/**
 * Pass B — extraction and scoring.
 *
 * Runs after the customer's turn, as a queued job. Three reasons it is separate
 * from the conversation (docs/00-architecture.md §4):
 *
 *   Latency      — the customer waits for Pass A only.
 *   Leak safety  — internal state lives in a context the customer cannot reach.
 *   Determinism  — a fixed schema at low effort, replayable against recorded
 *                  conversations, so scoring changes have a regression signal.
 */

const RECORD_TOOL_NAME = 'record_signals';

export interface ExtractionResult {
  leadId: string | null;
  signals: LeadSignals;
  priority?: 'low' | 'medium' | 'high';
  score?: number;
  rationale?: string;
  skipped?: 'no-lead' | 'no-client' | 'no-model' | 'no-signals' | 'invalid-output';
}

export async function extractAndScore(params: {
  tenantId: string;
  conversationId: string;
  client?: ModelClient | null;
}): Promise<ExtractionResult> {
  const client = params.client !== undefined ? params.client : modelClient();

  return withTenant(params.tenantId, async (db) => {
    const lead = await findLeadForConversation(db, params.conversationId);

    // No lead yet means nobody has identified themselves. Extraction would have
    // nothing to attach to, and creating a lead for an anonymous browser would
    // fill the portal with records staff cannot act on.
    if (!lead) return { leadId: null, signals: {}, skipped: 'no-lead' };
    if (!client) return { leadId: lead.id, signals: {}, skipped: 'no-client' };

    // Pass B, deterministically.
    //
    // Asking the rule-based assistant to read a transcript as prose would be a
    // pointless round trip. What it can do is exactly what the model is asked
    // to do — produce evidence — and the SAME rule engine turns that evidence
    // into a priority. No scoring happens here (spec §16).
    if (client instanceof RuleBasedModel) {
      const exchanges = await loadExchanges(db, params.conversationId);
      const vocabulary = await loadVocabulary(db);
      const signals = extractSignals(exchanges, {
        vocabulary,
        resolved: await resolveBuild(db, params.conversationId, exchanges, vocabulary),
      });

      const parsed = leadSignalsSchema.safeParse(signals);
      // Validated like any other extraction output. A field that does not fit
      // the contract is dropped rather than coerced, whatever produced it.
      if (!parsed.success) {
        return { leadId: lead.id, signals: {}, skipped: 'invalid-output' };
      }
      if (Object.keys(parsed.data).length === 0) {
        return { leadId: lead.id, signals: {}, skipped: 'no-signals' };
      }

      await applySignals(db, lead.id, parsed.data, { source: 'ai' });
      const scored = await recomputePriority(db, lead.id);
      await writeSummary(db, lead.id, parsed.data);
      await writeRollingSummary(db, params.conversationId, parsed.data);

      return {
        leadId: lead.id,
        signals: parsed.data,
        priority: scored.priority,
        score: scored.score,
        rationale: scored.rationale,
      };
    }

    const transcript = await loadTranscript(db, params.conversationId);
    if (transcript.length === 0) return { leadId: lead.id, signals: {}, skipped: 'no-signals' };

    const turn = await client.converse({
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }],
      model: EXTRACTION_MODEL,
      effort: 'medium',
      maxTokens: 2048,
      tools: [recordSignalsTool()],
    });

    const call = turn.toolUses.find((u) => u.name === RECORD_TOOL_NAME);
    if (!call) return { leadId: lead.id, signals: {}, skipped: 'no-signals' };

    // Strictly validated, never coerced. A malformed field is dropped rather
    // than guessed at — a hallucinated budget that becomes a HIGH-priority lead
    // sends a salesperson after a customer who never gave one.
    const parsed = leadSignalsSchema.safeParse(call.input);
    if (!parsed.success) {
      return { leadId: lead.id, signals: {}, skipped: 'invalid-output' };
    }

    await applySignals(db, lead.id, parsed.data, { source: 'ai' });
    const scored = await recomputePriority(db, lead.id);
    await writeSummary(db, lead.id, parsed.data);
    await writeRollingSummary(db, params.conversationId, parsed.data);

    return {
      leadId: lead.id,
      signals: parsed.data,
      priority: scored.priority,
      score: scored.score,
      rationale: scored.rationale,
    };
  });
}

function recordSignalsTool(): Anthropic.Tool {
  return {
    name: RECORD_TOOL_NAME,
    description: 'Record the facts the customer stated. Omit anything they did not say.',
    input_schema: zodToJsonSchema(leadSignalsSchema, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as Anthropic.Tool['input_schema'],
  };
}

/**
 * The conversation as customer messages paired with what preceded them.
 *
 * The same shape the assistant itself reads, so extraction sees exactly what
 * the conversation saw — including which question each answer was answering.
 */
async function loadExchanges(
  db: TenantDb,
  conversationId: string,
): Promise<{ asked: string; said: string }[]> {
  const rows = await db
    .select({ role: messagesTable.role, content: messagesTable.content })
    .from(messagesTable)
    .where(
      and(eq(messagesTable.tenantId, db.tenantId), eq(messagesTable.conversationId, conversationId)),
    )
    .orderBy(asc(messagesTable.seq));

  const exchanges: { asked: string; said: string }[] = [];
  let asked = '';

  for (const row of rows) {
    if (!row.content) continue;
    if (row.role === 'assistant') asked = row.content;
    else if (row.role === 'user') {
      exchanges.push({ asked, said: row.content });
      asked = '';
    }
  }
  return exchanges;
}

/** This tenant's range, so extraction recognises the same models the chat did. */
async function loadVocabulary(db: TenantDb) {
  const rows = await db
    .select({ slug: vehicleModels.slug, name: vehicleModels.fullName })
    .from(vehicleModels)
    .where(and(eq(vehicleModels.tenantId, db.tenantId), eq(vehicleModels.status, 'published')));
  return { models: rows };
}

/**
 * Configuration codes taken from the tool calls the conversation actually made.
 *
 * A code that reached a tool was validated by that tool, so it names a build
 * the dealership offers. Re-deriving codes from the customer's wording here
 * would be guessing at what was already established.
 */
async function resolveBuild(
  db: TenantDb,
  conversationId: string,
  exchanges: { asked: string; said: string }[],
  vocabulary: { models: { slug: string; name: string }[] },
): Promise<ResolvedBuild> {
  const fromTools = await loadResolvedBuild(db, conversationId);

  // A customer can state a trim without anything pricing it — "I want the S5
  // Premium, and can I drive it Saturday?" books a test drive and never calls
  // the price tool. So what they said is offered to the catalogue directly;
  // the catalogue still decides whether it names anything.
  const memory = remember(exchanges, vocabulary);
  if (!memory.modelSlug) return fromTools;

  const [model] = await db
    .select({ id: vehicleModels.id })
    .from(vehicleModels)
    .where(and(eq(vehicleModels.tenantId, db.tenantId), eq(vehicleModels.slug, memory.modelSlug)))
    .limit(1);
  if (!model) return fromTools;

  const resolved: ResolvedBuild = { ...fromTools };

  if (!resolved.trimCode) {
    const rows = await db
      .select({ code: trims.code, name: trims.name })
      .from(trims)
      .where(and(eq(trims.tenantId, db.tenantId), eq(trims.modelId, model.id)));
    resolved.trimCode = resolveTrim(memory.words, rows)?.code;
  }

  if (!resolved.powertrainCode) {
    const rows = await db
      .select({
        code: powertrains.code, name: powertrains.name, type: powertrains.kind,
      })
      .from(powertrains)
      .where(and(eq(powertrains.tenantId, db.tenantId), eq(powertrains.modelId, model.id)));
    resolved.powertrainCode = resolvePowertrain(
      memory.words,
      rows.map((row) => ({ ...row, offeredWithTrims: [] })),
    )?.code;
  }

  if (!resolved.exteriorColourCode && memory.colourWords.length > 0) {
    const rows = await db
      .select({ code: colours.code, name: colours.name })
      .from(colours)
      .where(
        and(
          eq(colours.tenantId, db.tenantId),
          eq(colours.modelId, model.id),
          eq(colours.kind, 'exterior'),
        ),
      );
    resolved.exteriorColourCode = resolveColour(memory.colourWords, rows)?.code;
  }

  return resolved;
}

async function loadResolvedBuild(
  db: TenantDb,
  conversationId: string,
): Promise<ResolvedBuild> {
  const rows = await db
    .select({ toolName: messagesTable.toolName, toolInput: messagesTable.toolInput })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.tenantId, db.tenantId),
        eq(messagesTable.conversationId, conversationId),
        eq(messagesTable.role, 'tool'),
      ),
    )
    .orderBy(asc(messagesTable.seq));

  const resolved: ResolvedBuild = {};
  for (const row of rows) {
    const input = (row.toolInput ?? {}) as Record<string, unknown>;
    if (typeof input.trimCode === 'string') resolved.trimCode = input.trimCode;
    if (typeof input.powertrainCode === 'string') resolved.powertrainCode = input.powertrainCode;
    if (typeof input.exteriorColourCode === 'string') {
      resolved.exteriorColourCode = input.exteriorColourCode;
    }
  }
  return resolved;
}

async function loadTranscript(db: TenantDb, conversationId: string): Promise<string> {
  const rows = await db
    .select({ role: messagesTable.role, content: messagesTable.content })
    .from(messagesTable)
    .where(
      and(eq(messagesTable.tenantId, db.tenantId), eq(messagesTable.conversationId, conversationId)),
    )
    .orderBy(asc(messagesTable.seq));

  return rows
    .filter((r) => r.role !== 'tool' && r.content)
    .map((r) => `${r.role === 'assistant' ? 'Specialist' : 'Customer'}: ${r.content}`)
    .join('\n');
}

/**
 * The internal summary staff read (spec §25).
 *
 * Assembled from the extracted facts rather than generated as prose: a summary
 * built from the structured record cannot introduce a detail that is not in it,
 * which is exactly the failure mode "do not generate fake details" warns about.
 */
async function writeSummary(db: TenantDb, leadId: string, signals: LeadSignals): Promise<void> {
  const parts: string[] = [];

  const model = signals.modelSlug?.value;
  const trim = signals.trimCode?.value;
  const powertrain = signals.powertrainCode?.value;
  if (model) {
    parts.push(
      `Interested in the ${[model.toUpperCase(), trim, powertrain].filter(Boolean).join(' ')}.`,
    );
  }
  if (signals.budgetCents?.value) {
    parts.push(`Budget around ${Math.round(signals.budgetCents.value / 100).toLocaleString()}.`);
  }
  if (signals.purchaseTimeframe?.value && signals.purchaseTimeframe.value !== 'unknown') {
    parts.push(`Purchase timeframe: ${signals.purchaseTimeframe.value.replace(/_/g, ' ')}.`);
  }
  if (signals.financeInterest?.value) parts.push('Raised financing.');
  if (signals.tradeInInterest?.value) parts.push('Has a vehicle to trade in.');
  if (signals.testDriveRequested?.value) {
    parts.push(
      signals.testDriveDate?.value
        ? `Asked for a test drive on ${signals.testDriveDate.value}.`
        : 'Asked about a test drive.',
    );
  }
  if (signals.wantsSalesperson?.value) parts.push('Asked to speak to a salesperson.');

  if (parts.length === 0) return;

  await db
    .update(leads)
    .set({ aiSummary: parts.join(' '), aiSummaryAt: new Date() })
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.id, leadId)));
}

/**
 * Resolve the conversation for this visitor, creating both if needed.
 *
 * The visitor row is created first: a conversation references one, and the
 * foreign key is what stops an orphaned conversation existing for a browser
 * session nothing else knows about.
 */
/**
 * A compact record of what the conversation established.
 *
 * The assistant only replays the last few turns verbatim; without this, a long
 * conversation silently forgets what was said earlier — which is exactly the
 * failure a customer notices and cannot explain.
 *
 * Built from the structured signals rather than by asking a model to summarise,
 * so it cannot introduce a detail the customer never gave.
 */
async function writeRollingSummary(
  db: TenantDb,
  conversationId: string,
  signals: LeadSignals,
): Promise<void> {
  const parts: string[] = [];

  if (signals.modelSlug?.value) {
    parts.push(
      `Looking at the ${[
        String(signals.modelSlug.value).toUpperCase(),
        signals.trimCode?.value,
        signals.powertrainCode?.value,
      ]
        .filter(Boolean)
        .join(' ')}`,
    );
  }
  if (signals.exteriorColourCode?.value) parts.push(`colour ${signals.exteriorColourCode.value}`);
  if (signals.budgetCents?.value) {
    parts.push(`budget about ${Math.round(signals.budgetCents.value / 100).toLocaleString()}`);
  }
  if (signals.purchaseTimeframe?.value && signals.purchaseTimeframe.value !== 'unknown') {
    parts.push(`buying ${String(signals.purchaseTimeframe.value).replace(/_/g, ' ')}`);
  }
  if (signals.tradeInInterest?.value) parts.push('has a trade-in');
  if (signals.financeInterest?.value) parts.push('interested in financing');

  if (parts.length === 0) return;

  await db
    .update(conversations)
    .set({ rollingSummary: `Earlier in this conversation: ${parts.join(', ')}.` })
    .where(
      and(eq(conversations.tenantId, db.tenantId), eq(conversations.id, conversationId)),
    );
}

export async function ensureConversation(
  tenantId: string,
  params: { conversationId?: string; visitorId?: string | null },
): Promise<{ conversationId: string; visitorId: string }> {
  return withTenant(tenantId, async (db) => {
    const visitorId = await ensureVisitor(db, params.visitorId);

    if (params.conversationId) {
      const existing = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.tenantId, db.tenantId), eq(conversations.id, params.conversationId)),
        )
        .limit(1);
      if (existing[0]) return { conversationId: existing[0].id, visitorId };
    }

    const created = await db
      .insert(conversations)
      .values({ tenantId: db.tenantId, visitorId })
      .returning({ id: conversations.id });
    return { conversationId: created[0]!.id, visitorId };
  });
}
