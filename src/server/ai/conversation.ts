import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import { and, eq, asc, sql } from 'drizzle-orm';
import { conversations, messages as messagesTable, vehicleModels } from '@/server/db/schema';
import { withTenant, type TenantDb } from '@/server/db/tenant-db';
import { getTenantById } from '@/server/context/tenant';
import { toolRegistry } from '@/server/ai/tools';
import type { ToolContext } from '@/server/ai/tools/define';
import { modelClient, type ModelClient } from '@/server/ai/client';
import { RuleBasedModel, ruleBasedClient } from '@/server/ai/rule-based';
import { buildSystemPrompt } from '@/server/ai/prompts/system';
import { buildPinnedFacts } from '@/server/ai/context';
import { formatMoney } from '@/server/services/pricing';
import { hasAiBudget, recordAiUsage } from '@/server/services/limits';
import { AppError } from '@/server/errors';

/**
 * Pass A — the customer conversation.
 *
 * This context contains only customer-safe data. It has never held a lead
 * score, a staff note or an internal summary, so it cannot leak one. That is a
 * structural property, not a promise the prompt makes (docs/00-architecture.md §4).
 */

/** Bounded so no single message can run the dealership's bill up. */
const MAX_TOOL_CALLS_PER_TURN = 6;
const MAX_WRITES_PER_TURN = 1;
const HISTORY_TURNS = 12;

/**
 * An on-screen confirmation for a completed action (spec §21).
 *
 * Captured from the write tool's own result rather than parsed out of the
 * assistant's prose: the customer's receipt must reflect what the backend
 * actually committed, not what the model said about it.
 */
export interface Receipt {
  ticketNumber: string;
  action: string;
  vehicle?: string;
  when?: string;
  confirmationCode?: string;
  /** Queued is not delivered. The wording travels with the fact. */
  confirmationEmail?: string;
}

/**
 * What the customer is told is happening while a tool runs.
 *
 * Mapped deliberately: internal tool names are not shown, and the phrasing says
 * what the dealership is doing rather than what the software is doing.
 */
const TOOL_STATUS: Record<string, string> = {
  searchVehicles: 'Looking through the range',
  getVehicle: 'Pulling up the details',
  getVehiclePowertrains: 'Checking the engine options',
  getVehicleTrims: 'Checking the trim levels',
  getVehicleColours: 'Checking the colours',
  getVehicleOptions: 'Checking the options',
  getVehicleFeatures: 'Checking the specification',
  calculateVehiclePrice: 'Working out the price',
  compareVehicles: 'Comparing them',
  checkInventory: 'Checking what we have in stock',
  calculateFinanceEstimate: 'Working out an estimate',
  getDealershipInformation: 'Checking our details',
  getDealershipHours: 'Checking our hours',
  getAvailableTestDriveSlots: 'Checking the diary',
  createTestDrive: 'Booking that in',
  cancelTestDrive: 'Cancelling that for you',
  createCallbackRequest: 'Passing that to the team',
  createSupportTicket: 'Passing that to the team',
  createTradeInRequest: 'Recording your vehicle',
  createFinancingRequest: 'Passing that to the team',
  requestHumanHandoff: 'Getting a specialist',
  saveBuild: 'Saving your specification',
  updateContactPreferences: 'Noting your details',
};

export interface ConversationStream {
  /** Text as it arrives, including any preamble before a tool call. */
  onDelta?: (text: string) => void;
  /** A customer-safe phrase while a tool runs. Never a tool name. */
  onStatus?: (status: string) => void;
}

export interface ConversationReply {
  text: string;
  conversationId: string;
  toolsUsed: string[];
  degraded: boolean;
  /**
   * Which assistant answered.
   *
   * 'scripted' is the rule-based assistant: real tools and real data, a fixed
   * set of instructions. 'offline' is the contact-form path, where no
   * assistant answered at all. 'handed_off' is a person having taken the
   * thread over — the customer's message is recorded and the assistant says
   * nothing.
   */
  mode: 'model' | 'scripted' | 'offline' | 'handed_off';
  receipt?: Receipt;
}

export async function respondToMessage(params: {
  tenantId: string;
  conversationId: string;
  visitorId: string;
  userMessage: string;
  requestId: string;
  now?: Date;
  client?: ModelClient | null;
  stream?: ConversationStream;
}): Promise<ConversationReply> {
  const tenant = await getTenantById(params.tenantId);
  let client = params.client !== undefined ? params.client : modelClient();
  const now = params.now ?? new Date();

  // A dealership that has spent its monthly budget falls back to the scripted
  // assistant rather than to a dead end. It costs nothing to run and still
  // books a test drive; the customer sees a plainer assistant, never a bill.
  if (
    client &&
    params.client === undefined &&
    !(client instanceof RuleBasedModel) &&
    !(await hasAiBudget(params.tenantId))
  ) {
    client = ruleBasedClient();
  }

  if (!client) {
    // Degraded mode. The customer gets an honest answer and a route to a
    // person, never a fabricated one (spec §34).
    const message =
        `I can't reach our assistant service just now. You can browse the ${tenant.brandName} ` +
        `range here, and if you leave your details the team will follow up directly.`;

    // Streamed too, so the interface has one path rather than two.
    params.stream?.onDelta?.(message);

    return {
      text: message,
      conversationId: params.conversationId,
      toolsUsed: [],
      degraded: true,
      mode: 'offline',
    };
  }

  const registry = toolRegistry();

  return withTenant(params.tenantId, async (db) => {
    // Three independent reads, issued together so the driver pipelines them
    // into one round trip instead of three. See `writeMessages` for why the
    // customer's own message is not written before them.
    const [{ history, nextSeq }, pinned, catalogueDigest, takeover] = await Promise.all([
      loadHistory(db, params.conversationId),
      // What the customer has already established, so they are never asked
      // twice and an unqualified "the Premium" resolves to the car they are
      // looking at.
      buildPinnedFacts(db, params.conversationId),
      buildCatalogueDigest(db, tenant),
      // Has a person taken this thread over? Read alongside the others rather
      // than before them: it is one more column in the same round trip.
      isHandedOff(db, params.conversationId),
    ]);

    const pending = new MessageBuffer(nextSeq);
    pending.add({ role: 'user', content: params.userMessage });

    // A salesperson is handling this conversation. The customer's message is
    // still recorded — it is theirs, and staff need to see it — but the
    // assistant does not answer.
    //
    // On the website that would merely be untidy. In a messaging thread the
    // customer is watching, an assistant that keeps talking is talking over
    // the person who took over, in public, under the dealership's name.
    if (takeover) {
      await writeMessages(db, params.conversationId, pending.entries);
      await db
        .update(conversations)
        .set({ lastMessageAt: sql`now()` })
        .where(
          and(
            eq(conversations.tenantId, db.tenantId),
            eq(conversations.id, params.conversationId),
          ),
        );

      return {
        text: '',
        conversationId: params.conversationId,
        toolsUsed: [],
        degraded: false,
        mode: 'handed_off',
      };
    }

    const system = buildSystemPrompt({
      brandName: tenant.brandName,
      timezone: tenant.timezone,
      locale: tenant.locale,
      currency: tenant.currency,
      catalogueDigest,
      responseSlaHours: 1,
      knownFacts: pinned.facts,
      earlier: pinned.earlier,
      nowLocal: new Intl.DateTimeFormat(tenant.locale, {
        timeZone: tenant.timezone, dateStyle: 'full',
      }).format(now),
    });

    const ctx: ToolContext = {
      tenantId: params.tenantId,
      conversationId: params.conversationId,
      visitorId: params.visitorId,
      requestId: params.requestId,
      now,
      tenant: {
        brandName: tenant.brandName,
        timezone: tenant.timezone,
        locale: tenant.locale,
        currency: tenant.currency,
        ticketPrefix: tenant.ticketPrefix,
      },
      db,
    };

    const conversation: Anthropic.MessageParam[] = [
      ...history,
      { role: 'user', content: params.userMessage },
    ];
    const toolsUsed: string[] = [];
    let writes = 0;
    let finalText = '';
    let receipt: Receipt | undefined;

    for (let iteration = 0; iteration < MAX_TOOL_CALLS_PER_TURN; iteration++) {
      const request = {
        system,
        messages: conversation,
        tools: registry.schemas() as Anthropic.Tool[],
        effort: 'low' as const,
      };

      const turn = params.stream?.onDelta
        ? await client.stream(request, params.stream.onDelta)
        : await client.converse(request);

      // Each iteration's text is a separate utterance: a preamble before a
      // tool call, then the answer. Concatenated, because the customer has
      // already seen both stream past — replacing would contradict the screen.
      await recordAiUsage(db, turn.usage);

      if (turn.text) finalText = finalText ? `${finalText}\n\n${turn.text}` : turn.text;

      if (turn.toolUses.length === 0) break;

      conversation.push({
        role: 'assistant',
        content: [
          ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
          ...turn.toolUses.map((u) => ({
            type: 'tool_use' as const, id: u.id, name: u.name, input: u.input as object,
          })),
        ],
      });

      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const use of turn.toolUses) {
        const definition = registry.get(use.name)?.definition;
        const status = TOOL_STATUS[use.name];
        if (status) params.stream?.onStatus?.(status);

        // One write per turn: no single customer message should be able to
        // create a lead, a ticket and an appointment at once.
        if (definition?.scope === 'write' && ++writes > MAX_WRITES_PER_TURN) {
          results.push({
            type: 'tool_result', tool_use_id: use.id, is_error: true,
            content: 'Only one booking or request can be made per message.',
          });
          continue;
        }

        const outcome = await registry.dispatch(ctx, use.name, use.input);
        toolsUsed.push(use.name);

        if (outcome.ok && definition?.scope === 'write') {
          receipt = toReceipt(use.name, outcome.result) ?? receipt;
        }

        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          is_error: !outcome.ok,
          content: JSON.stringify(outcome.ok ? outcome.result : outcome.error),
        });

        pending.add({
          role: 'tool',
          toolName: use.name,
          toolInput: use.input,
          toolResult: outcome.ok ? outcome.result : outcome.error,
        });
      }

      // Every tool_result goes back in ONE user message. Splitting them across
      // messages trains the model out of making parallel calls.
      conversation.push({ role: 'user', content: results });
    }

    if (!finalText) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'I could not complete that just now.');
    }

    pending.add({ role: 'assistant', content: finalText });

    // The turn's whole transcript in one insert, issued together with the
    // conversation's timestamp. Both are writes to different tables with no
    // dependency between them, so they cost one round trip, not two.
    await Promise.all([
      writeMessages(db, params.conversationId, pending.entries),
      db
        .update(conversations)
        .set({ lastMessageAt: sql`now()` })
        .where(
          and(
            eq(conversations.tenantId, db.tenantId),
            eq(conversations.id, params.conversationId),
          ),
        ),
    ]);

    return {
      text: finalText,
      conversationId: params.conversationId,
      toolsUsed,
      degraded: false,
      mode: client instanceof RuleBasedModel ? 'scripted' : 'model',
      ...(receipt ? { receipt } : {}),
    };
  });
}

const RECEIPT_ACTIONS: Record<string, string> = {
  createTestDrive: 'Test drive booked',
  createCallbackRequest: 'Callback requested',
  createSupportTicket: 'Enquiry received',
  createTradeInRequest: 'Trade-in appraisal requested',
  createFinancingRequest: 'Financing enquiry received',
  requestHumanHandoff: 'Passed to a specialist',
};

function toReceipt(toolName: string, result: unknown): Receipt | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const data = result as Record<string, unknown>;
  if (typeof data.ticketNumber !== 'string') return undefined;

  return {
    ticketNumber: data.ticketNumber,
    action: RECEIPT_ACTIONS[toolName] ?? 'Request received',
    ...(typeof data.vehicle === 'string' ? { vehicle: data.vehicle } : {}),
    ...(typeof data.when === 'string' ? { when: data.when } : {}),
    ...(typeof data.confirmationCode === 'string'
      ? { confirmationCode: data.confirmationCode }
      : {}),
    ...(typeof data.confirmationEmail === 'string'
      ? { confirmationEmail: data.confirmationEmail }
      : {}),
  };
}

interface PendingMessage {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
}

/**
 * The turn's transcript, held until the end of the turn.
 *
 * It used to be written a row at a time, and each row cost two round trips: one
 * to read `max(seq) + 1` and one to insert. A turn that calls three tools wrote
 * five rows, which was ten round trips spent on bookkeeping the customer never
 * sees — and the read-then-insert was a race besides, because two messages in
 * the same conversation could read the same maximum.
 *
 * Sequence numbers are handed out from the count already loaded with the
 * history, so there is no extra read, and the rows go in as one statement at
 * the end of the turn. Nothing within a turn reads its own transcript back,
 * and the whole turn is one transaction either way, so holding the rows
 * changes no durability guarantee: they commit together or not at all.
 */
class MessageBuffer {
  readonly entries: PendingMessage[] = [];
  private seq: number;

  constructor(nextSeq: number) {
    this.seq = nextSeq;
  }

  add(message: Omit<PendingMessage, 'seq'>): void {
    this.entries.push({ ...message, seq: this.seq++ });
  }
}

/**
 * Whether a person has taken this conversation over.
 *
 * Both signals, because they can disagree: `status` is what the portal shows
 * and `handed_off_at` is when it happened, and a row that carries either is a
 * row the assistant must not answer for. Treating only one as authoritative
 * would make an assistant that resumes talking because a status was reset
 * while a salesperson was still mid-thread.
 */
async function isHandedOff(db: TenantDb, conversationId: string): Promise<boolean> {
  const rows = await db
    .select({ status: conversations.status, handedOffAt: conversations.handedOffAt })
    .from(conversations)
    .where(and(eq(conversations.tenantId, db.tenantId), eq(conversations.id, conversationId)))
    .limit(1);

  const row = rows[0];
  return Boolean(row && (row.status === 'handed_off' || row.handedOffAt));
}

async function writeMessages(
  db: TenantDb,
  conversationId: string,
  entries: PendingMessage[],
): Promise<void> {
  if (entries.length === 0) return;

  await db.insert(messagesTable).values(
    entries.map((message) => ({
      tenantId: db.tenantId,
      conversationId,
      seq: message.seq,
      role: message.role,
      content: message.content ?? null,
      toolName: message.toolName ?? null,
      toolInput: (message.toolInput ?? null) as never,
      toolResult: (message.toolResult ?? null) as never,
    })),
  );
}

/**
 * The recent turns, in the shape the model expects.
 *
 * Tool messages are deliberately NOT replayed: their results were already
 * folded into the assistant's reply, and replaying stale availability or
 * pricing invites the model to quote a figure that has since changed.
 */
async function loadHistory(
  db: TenantDb,
  conversationId: string,
): Promise<{ history: Anthropic.MessageParam[]; nextSeq: number }> {
  const rows = await db
    .select({
      seq: messagesTable.seq,
      role: messagesTable.role,
      content: messagesTable.content,
    })
    .from(messagesTable)
    .where(
      and(eq(messagesTable.tenantId, db.tenantId), eq(messagesTable.conversationId, conversationId)),
    )
    .orderBy(asc(messagesTable.seq));

  const history = rows
    .filter((r) => r.role !== 'tool' && r.content)
    .slice(-HISTORY_TURNS * 2)
    .map((r) => ({
      role: r.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: r.content!,
    }));

  // Every row for the conversation is read, so the last sequence number is
  // exact — this turn's rows can be numbered without asking the database again.
  const last = rows.length > 0 ? Number(rows[rows.length - 1]!.seq) : 0;
  return { history, nextSeq: last + 1 };
}

/**
 * Names, segments and price-from. Enough for the model to route a question to
 * the right tool; not enough to answer one without calling a tool.
 */
async function buildCatalogueDigest(
  db: TenantDb,
  tenant: { currency: string; locale: string },
): Promise<string> {
  const models = await db
    .select({
      slug: vehicleModels.slug,
      fullName: vehicleModels.fullName,
      segment: vehicleModels.segment,
      baseMsrpCents: vehicleModels.baseMsrpCents,
    })
    .from(vehicleModels)
    .where(and(eq(vehicleModels.tenantId, db.tenantId), eq(vehicleModels.status, 'published')))
    .orderBy(asc(vehicleModels.displayOrder));

  return models
    .map(
      (m) =>
        `- ${m.fullName} (${m.slug}) — ${m.segment}, from ${formatMoney(m.baseMsrpCents, tenant.currency, tenant.locale)}`,
    )
    .join('\n');
}
