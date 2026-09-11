import 'server-only';
import { and, eq } from 'drizzle-orm';
import { messages, leads } from '@/server/db/schema';
import { withTenant } from '@/server/db/tenant-db';
import { respondToMessage } from '@/server/ai/conversation';
import { ensureConversation } from '@/server/ai/extraction';
import { applySignals, recomputePriority, findLeadForConversation } from '@/server/services/leads';
import { modelClient, type ModelClient, type ModelRequest, type ModelTurn } from '@/server/ai/client';
import {
  DEFAULT_EVAL_BUDGET, estimateCostUsd,
  type EvalBudget, type EvalCase, type EvalResult, type TokenUsage,
} from './types';

/**
 * The evaluation runner.
 *
 * Runs a case through the REAL spine — real tools, real database, real
 * projections — so what it measures is the system as shipped, not a mock of it.
 * Only the model is substituted, and only in scripted mode.
 */

/**
 * Wraps the live client to meter spend and stop when the budget is reached.
 *
 * The cap is enforced here rather than trusted to the corpus: a case that
 * loops, or a model that keeps calling tools, must not be able to run up a
 * bill on the operator's account.
 */
class MeteredClient implements ModelClient {
  readonly usage: TokenUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };

  constructor(
    private readonly inner: ModelClient,
    private readonly budget: EvalBudget,
  ) {}

  private assertWithinBudget(): void {
    const spent = this.usage.inputTokens + this.usage.outputTokens;
    if (this.usage.requests >= this.budget.maxRequests) {
      throw new Error(`Evaluation budget reached: ${this.budget.maxRequests} requests`);
    }
    if (spent >= this.budget.maxTokens) {
      throw new Error(`Evaluation budget reached: ${this.budget.maxTokens} tokens`);
    }
    if (estimateCostUsd(this.usage) >= this.budget.maxCostUsd) {
      throw new Error(`Evaluation budget reached: $${this.budget.maxCostUsd}`);
    }
  }

  private record(turn: ModelTurn): ModelTurn {
    this.usage.inputTokens += turn.usage.inputTokens;
    this.usage.outputTokens += turn.usage.outputTokens;
    this.usage.requests += 1;
    return turn;
  }

  async converse(request: ModelRequest): Promise<ModelTurn> {
    this.assertWithinBudget();
    return this.record(await this.inner.converse(request));
  }

  async stream(request: ModelRequest, onDelta: (text: string) => void): Promise<ModelTurn> {
    this.assertWithinBudget();
    return this.record(await this.inner.stream(request, onDelta));
  }
}

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
  options: { live?: boolean; meter?: MeteredClient } = {},
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

  const client = live ? (options.meter ?? modelClient()) : new CaseModel(script);
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
    try {
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
    } catch (error) {
      // A model or budget failure is a RESULT, not a crash: the report should
      // say what happened rather than the run dying half way through.
      failures.push(
        `turn failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
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

export interface CorpusReport {
  results: EvalResult[];
  usage: TokenUsage;
  estimatedCostUsd: number;
  stoppedEarly: boolean;
}

export async function runCorpus(
  tenantId: string,
  cases: EvalCase[],
  options: { live?: boolean; budget?: EvalBudget } = {},
): Promise<CorpusReport> {
  const live = options.live ?? false;
  const budget = options.budget ?? DEFAULT_EVAL_BUDGET;

  const applicable = cases.filter(
    (c) => c.mode === 'both' || c.mode === (live ? 'live' : 'scripted'),
  );

  const inner = live ? modelClient() : null;
  const meter = live && inner ? new MeteredClient(inner, budget) : undefined;

  const results: EvalResult[] = [];
  let stoppedEarly = false;

  for (const testCase of applicable) {
    const before = meter ? { ...meter.usage } : undefined;
    const result = await runCase(tenantId, testCase, { live, meter });

    if (meter && before) {
      result.usage = {
        inputTokens: meter.usage.inputTokens - before.inputTokens,
        outputTokens: meter.usage.outputTokens - before.outputTokens,
        requests: meter.usage.requests - before.requests,
      };
    }
    results.push(result);

    if (result.failures.some((f) => f.includes('budget reached'))) {
      stoppedEarly = true;
      break;
    }
  }

  const usage = meter?.usage ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
  return { results, usage, estimatedCostUsd: estimateCostUsd(usage), stoppedEarly };
}

export { EVAL_CASES } from './cases';
export type { EvalCase, EvalResult } from './types';
