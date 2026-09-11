/**
 * The assistant evaluation corpus.
 *
 * Two modes, and the difference matters:
 *
 *   SCRIPTED — the tool choices come from the case, so what is measured is the
 *              SYSTEM: does it ground answers in tool results, refuse what it
 *              cannot verify, keep internal data out of the model's context,
 *              and score the lead correctly? Runs in CI, needs no API key.
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
  toolsUsed: string[];
  replies: string[];
  priority?: string;
}
