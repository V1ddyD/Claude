import 'server-only';
import { and, eq } from 'drizzle-orm';
import { messages, leads } from '@/server/db/schema';
import { withTenant } from '@/server/db/tenant-db';
import { respondToMessage } from '@/server/ai/conversation';
import { ensureConversation } from '@/server/ai/extraction';
import { applySignals, recomputePriority, findLeadForConversation } from '@/server/services/leads';
import { modelClient, type ModelClient, type ModelRequest, type ModelTurn } from '@/server/ai/client';
import type { EvalCase, EvalResult } from './types';

/**
 * The evaluation runner.
 *
 * Runs a case through the REAL spine — real tools, real database, real
 * projections — so what it measures is the system as shipped, not a mock of it.
 * Only the model is substituted, and only in scripted mode.
 */

/** Replays a case's scripted turns, one model turn at a time. */
class CaseModel implements ModelClient {
  readonly seen: string[] = [];
  private index = 0;

  constructor(private readonly script: { text: string; tools: ModelTurn['toolUses'] }[]) {}

  async converse(request: ModelRequest): Promise<ModelTurn> {
    this.seen.push(request.system + JSON.stringify(request.messages));
    const turn = this.script[this.index++] ?? { text: '', tools: [] };
    return {
      text: turn.text,
      toolUses: turn.tools,
      stopReason: turn.tools.length > 0 ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async stream(request: ModelRequest, onDelta: (text: string) => void): Promise<ModelTurn> {
    const turn = await this.converse(request);
    onDelta(turn.text);
    return turn;
  }
}

export async function runCase(
  tenantId: string,
  testCase: EvalCase,
  options: { live?: boolean } = {},
): Promise<EvalResult> {
  const live = options.live ?? false;
  const failures: string[] = [];
  const replies: string[] = [];
  const toolsUsed: string[] = [];

  const session = await ensureConversation(tenantId, {});

  // In scripted mode each turn contributes its tool call and then its reply,
  // which is two model turns — the same shape the loop sees in production.
  const script = testCase.turns.flatMap((turn) => [
    ...(turn.tools?.length
      ? [{
          text: '',
          tools: turn.tools.map((t, i) => ({ id: `toolu_${i}`, name: t.name, input: t.input })),
        }]
      : []),
    { text: turn.reply ?? '', tools: [] },
  ]);

  const client = live ? modelClient() : new CaseModel(script);
  if (!client) {
    return {
      name: testCase.name,
      intent: testCase.intent,
      passed: false,
      failures: ['live mode requested but no model is configured'],
      toolsUsed: [],
      replies: [],
    };
  }

  for (const turn of testCase.turns) {
    const reply = await respondToMessage({
      tenantId,
      conversationId: session.conversationId,
      visitorId: session.visitorId,
      userMessage: turn.user,
      requestId: `eval:${testCase.name}`,
      client,
    });
    replies.push(reply.text);
    toolsUsed.push(...reply.toolsUsed);
  }

  // Scoring is exercised by feeding the case's signals through the real
  // pipeline rather than by calling the scorer directly.
  let priority: string | undefined;
  if (testCase.signals) {
    await withTenant(tenantId, async (db) => {
      const lead = await findLeadForConversation(db, session.conversationId);
      if (!lead) return;
      await applySignals(db, lead.id, testCase.signals as never, { source: 'ai' });
      priority = (await recomputePriority(db, lead.id)).priority;
    });
  } else {
    priority = await withTenant(tenantId, async (db) => {
      const rows = await db
        .select({ priority: leads.priority })
        .from(leads)
        .where(and(eq(leads.tenantId, db.tenantId), eq(leads.conversationId, session.conversationId)))
        .limit(1);
      return rows[0]?.priority;
    });
  }

  // ---- Assertions ---------------------------------------------------------
  const expect = testCase.expect;

  for (const tool of expect.calledTools ?? []) {
    if (!toolsUsed.includes(tool)) failures.push(`expected ${tool} to be called`);
  }
  for (const tool of expect.neverCalledTools ?? []) {
    if (toolsUsed.includes(tool)) failures.push(`${tool} should not have been called`);
  }

  const allReplies = replies.join('\n').toLowerCase();
  for (const phrase of expect.neverInReply ?? []) {
    if (allReplies.includes(phrase.toLowerCase())) {
      failures.push(`reply contained "${phrase}"`);
    }
  }

  const modelSaw = client instanceof CaseModel ? client.seen.join('\n') : '';
  for (const phrase of expect.neverInModelContext ?? []) {
    if (modelSaw.includes(phrase)) failures.push(`"${phrase}" reached the model context`);
  }

  if (expect.toolErrorCode) {
    const toolResults = await withTenant(tenantId, (db) =>
      db
        .select({ result: messages.toolResult })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, db.tenantId),
            eq(messages.conversationId, session.conversationId),
            eq(messages.role, 'tool'),
          ),
        ),
    );
    const codes = toolResults.map((r) => (r.result as { code?: string } | null)?.code);
    if (!codes.includes(expect.toolErrorCode)) {
      failures.push(`expected a tool to return ${expect.toolErrorCode}, saw ${codes.join(', ') || 'none'}`);
    }
  }

  if (expect.priority && priority !== expect.priority) {
    failures.push(`expected priority ${expect.priority}, got ${priority ?? 'none'}`);
  }

  return {
    name: testCase.name,
    intent: testCase.intent,
    passed: failures.length === 0,
    failures,
    toolsUsed,
    replies,
    ...(priority ? { priority } : {}),
  };
}

export async function runCorpus(
  tenantId: string,
  cases: EvalCase[],
  options: { live?: boolean } = {},
): Promise<EvalResult[]> {
  const live = options.live ?? false;
  const applicable = cases.filter(
    (c) => c.mode === 'both' || c.mode === (live ? 'live' : 'scripted'),
  );

  const results: EvalResult[] = [];
  for (const testCase of applicable) {
    results.push(await runCase(tenantId, testCase, options));
  }
  return results;
}

export { EVAL_CASES } from './cases';
export type { EvalCase, EvalResult } from './types';
