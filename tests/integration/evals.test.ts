import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prepareDatabase } from '../helpers/db';
import { SINCLAIR_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { runCorpus, EVAL_CASES } from '../../src/server/ai/evals/run';

/**
 * The evaluation corpus, in scripted mode.
 *
 * What this proves: given a set of tool calls, the SYSTEM grounds answers in
 * real results, refuses what it cannot verify, keeps internal data out of the
 * model's context, and scores the lead correctly.
 *
 * What it does NOT prove: that the model picks the right tool. That is the
 * live-mode corpus, which needs a key — see `npm run eval:live`.
 */

beforeAll(async () => {
  await prepareDatabase();
});
afterAll(async () => {
  await closeConnections();
});

describe('the assistant corpus', () => {
  it('passes every scripted case', async () => {
    const { results } = await runCorpus(SINCLAIR_TENANT_ID, EVAL_CASES);
    expect(results.length).toBeGreaterThan(5);

    const failed = results.filter((r) => !r.passed);
    // The intent is printed on failure: a case that breaks should explain what
    // it was protecting without anyone having to read the corpus.
    const detail = failed
      .map((r) => `\n  ${r.name}\n    why it exists: ${r.intent}\n    ${r.failures.join('\n    ')}`)
      .join('');

    expect(failed.map((r) => r.name), detail).toEqual([]);
  }, 60_000);

  it('covers the failures that actually cost a dealership money', () => {
    const names = EVAL_CASES.map((c) => c.name).join(' ');
    // Not a coverage metric — a reminder of what the corpus is for.
    expect(names).toMatch(/does not exist/);
    expect(names).toMatch(/not built/);
    expect(names).toMatch(/not a valuation/);
    expect(names).toMatch(/estimates, never offers/);
    expect(names).toMatch(/nothing internal/);
  });

  it('keeps live-only cases out of the scripted run', async () => {
    // A live case scripted into passing would be worse than no case at all.
    const { results } = await runCorpus(SINCLAIR_TENANT_ID, EVAL_CASES);
    const liveOnly = EVAL_CASES.filter((c) => c.mode === 'live').map((c) => c.name);

    expect(liveOnly.length).toBeGreaterThan(0);
    for (const name of liveOnly) {
      expect.soft(results.map((r) => r.name)).not.toContain(name);
    }
  }, 60_000);
});
