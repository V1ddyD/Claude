/**
 * The assistant evaluation corpus.
 *
 * Three ways to run it, and the differences matter:
 *
 *   SCRIPTED — the tool choices come from the case, so what is measured is the
 *              SYSTEM: does it ground answers in tool results, refuse what it
 *              cannot verify, keep internal data out of the model's context,
 *              and score the lead correctly? Runs in CI, needs no API key.
 *
 *   RULES    — the rule-based assistant makes its own choices, so what is
 *              measured is the assistant that SHIPS TODAY. Needs no key.
 *              Read the caveat on `EvalResult.observations` before reading a
 *              green run as a green live run: it is not one.
 *
 *   LIVE     — the model makes its own choices, so what is measured is the
 *              MODEL: does it reach for the right tool, decline to invent,
 *              hand off when it should? Needs a key. Run before a demo and
 *              after any prompt change.
 *
 * A case that only makes sense in one mode declares it. Writing a case that
 * "passes" in scripted mode by scripting the answer it is supposed to test is
 * the easy mistake here, and `mode` is what keeps it honest.
 */

export type EvalMode = 'scripted' | 'live' | 'both';

/** How a run drives the assistant. Not the same axis as a case's `mode`. */
export type EvalDriver = 'scripted' | 'rules' | 'live';

export interface EvalTurn {
  /** What the customer says. */
  user: string;
  /**
   * Tool calls to script. Scripted mode only — in live mode the model chooses,
   * and these become the EXPECTATION instead.
   */
  tools?: { name: string; input: Record<string, unknown> }[];
  /** The assistant's reply in scripted mode. */
  reply?: string;
}

export interface EvalExpectation {
  /** Tools that must have been called across the conversation. */
  calledTools?: string[];
  /** Tools that must NOT have been called. */
  neverCalledTools?: string[];
  /** Strings that must not appear in anything the model was shown. */
  neverInModelContext?: string[];
  /** Strings that must not appear in any assistant reply. */
  neverInReply?: string[];
  /** The priority band the lead should land in. */
  priority?: 'low' | 'medium' | 'high';
  /** A tool result that must have carried this error code. */
  toolErrorCode?: string;
  /** Signals the extraction pass should have produced. */
  extracted?: Record<string, unknown>;
}

export interface EvalCase {
  name: string;
  /** Why this case exists. Shown on failure. */
  intent: string;
  mode: EvalMode;
  turns: EvalTurn[];
  /** Signals to feed the extraction pass in scripted mode. */
  signals?: Record<string, { value: unknown; confidence: number }>;
  expect: EvalExpectation;
}

export interface EvalResult {
  name: string;
  intent: string;
  passed: boolean;
  failures: string[];
  /**
   * Expectations that did not hold but are not counted as failures.
   *
   * Only in `rules` mode, and only for the positive assertions — which tool
   * was called, which error code came back, which priority band the lead
   * landed in. Those describe HOW the model is expected to reach an answer,
   * and the rule-based assistant legitimately reaches some of them another
   * way: asked about a car we do not make, it answers from the catalogue
   * digest it was given rather than by calling a tool and being refused.
   *
   * The safety assertions are never downgraded. A tool that must not be
   * called, a phrase that must not appear in a reply, internal data that must
   * not reach the assistant's context — those are failures in every mode.
   *
   * So a green `rules` run means "said nothing it should not have". It does
   * NOT mean "chose the tools a model would choose", and it is not a
   * substitute for a live run.
   */
  observations: string[];
  toolsUsed: string[];
  replies: string[];
  priority?: string;
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

/**
 * Bounds on a live run.
 *
 * A live evaluation spends real money on someone else's account, so it stops
 * on its own rather than relying on the corpus staying small.
 */
export interface EvalBudget {
  maxRequests: number;
  maxTokens: number;
  maxCostUsd: number;
}

export const DEFAULT_EVAL_BUDGET: EvalBudget = {
  maxRequests: 60,
  maxTokens: 400_000,
  maxCostUsd: 2.0,
};

/** Claude Opus 5, per million tokens. */
export const PRICING = { inputPerMTok: 5.0, outputPerMTok: 25.0 } as const;

export function estimateCostUsd(usage: TokenUsage): number {
  return (
    (usage.inputTokens / 1_000_000) * PRICING.inputPerMTok +
    (usage.outputTokens / 1_000_000) * PRICING.outputPerMTok
  );
}
