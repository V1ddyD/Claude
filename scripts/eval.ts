/**
 * Run the assistant evaluation corpus.
 *
 *   npm run eval          scripted — measures the system, no key needed
 *   npm run eval:rules    rules    — measures the assistant that ships today
 *   npm run eval:live     live     — measures the model, needs ANTHROPIC_API_KEY
 *
 * Run the live corpus before a demo and after any change to the system prompt,
 * the tool descriptions or the model.
 *
 * `rules` drives the rule-based assistant through its own tool choices. Read
 * the caveat printed at the end of the run: a green rules run says the
 * assistant said nothing it should not have, NOT that it chose what a model
 * would choose. It is not a substitute for a live run.
 */
import { loadEnvFile } from '../src/server/config/load-env-file';
loadEnvFile('.env.local', '.env.test.local');

const live = process.argv.includes('--live');
const rules = process.argv.includes('--rules');
const driver = live ? 'live' : rules ? 'rules' : 'scripted';

async function main() {
  const { runCorpus, EVAL_CASES } = await import('../src/server/ai/evals/run');
  const { listActiveTenantIds } = await import('../src/server/db/control-plane');
  const { closeConnections } = await import('../src/server/db/client');

  const [tenantId] = await listActiveTenantIds();
  if (!tenantId) {
    console.error('No tenant found. Run `npm run db:seed` first.');
    process.exit(1);
  }

  if (live && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(
      'Live mode needs a credential. Set ANTHROPIC_API_KEY in .env.local — the\n' +
        "operator's key, set once, server-side. It is never something a customer\n" +
        'supplies, and it is never sent to a browser.',
    );
    process.exit(1);
  }

  if (live) {
    console.log(
      'LIVE evaluation. This spends real money on the configured account.\n' +
        'It stops on its own at 60 requests, 400k tokens or $2.00, whichever comes first.\n',
    );
  }

  console.log(`Running the ${driver.toUpperCase()} corpus...\n`);
  const report = await runCorpus(tenantId, EVAL_CASES, { driver });
  const { results } = report;

  for (const result of results) {
    console.log(`${result.passed ? '  PASS' : '  FAIL'}  ${result.name}`);
    if (!result.passed) {
      console.log(`        why it exists: ${result.intent}`);
      for (const failure of result.failures) console.log(`        - ${failure}`);
      if (result.toolsUsed.length > 0) {
        console.log(`        tools called: ${result.toolsUsed.join(', ')}`);
      }
    } else if (driver !== 'scripted' && result.toolsUsed.length > 0) {
      // When the assistant chose its own tools, those choices are the
      // interesting part — they are what the scripted corpus cannot measure.
      console.log(`        tools called: ${result.toolsUsed.join(', ')}`);
    }
    for (const observation of result.observations) {
      // Not a failure. A difference in how the answer was reached.
      console.log(`        note: ${observation}`);
    }
    if (result.usage?.requests) {
      console.log(
        `        ${result.usage.requests} request(s), ` +
          `${result.usage.inputTokens} in / ${result.usage.outputTokens} out`,
      );
    }
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed.`);

  if (rules) {
    const noted = results.reduce((total, r) => total + r.observations.length, 0);
    console.log(
      `\n${noted} note(s): expectations about WHICH tool a model would reach for, where\n` +
        'the rule-based assistant reached the same answer another way. Those are not\n' +
        'counted as failures. What IS counted: a tool it must not call, a phrase it must\n' +
        'not say, internal data reaching its context.\n' +
        '\nA green run here means it said nothing it should not have. It does not measure\n' +
        'the model — only `npm run eval:live` does that.',
    );
  }

  if (live) {
    console.log(
      `\nSpend: ${report.usage.requests} requests, ` +
        `${report.usage.inputTokens.toLocaleString()} input / ` +
        `${report.usage.outputTokens.toLocaleString()} output tokens` +
        `\nEstimated cost: $${report.estimatedCostUsd.toFixed(4)} at Opus 5 rates.`,
    );
    if (report.stoppedEarly) {
      console.log('\nSTOPPED EARLY: the budget cap was reached before the corpus finished.');
    }
  }

  await closeConnections();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
