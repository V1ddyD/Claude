/**
 * Run the assistant evaluation corpus.
 *
 *   npm run eval         scripted — measures the system, no key needed
 *   npm run eval:live    live     — measures the model, needs ANTHROPIC_API_KEY
 *
 * Run the live corpus before a demo and after any change to the system prompt,
 * the tool descriptions or the model.
 */
import { loadEnvFile } from '../src/server/config/load-env-file';
loadEnvFile('.env.local', '.env.test.local');

const live = process.argv.includes('--live');

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

  console.log(`Running the ${live ? 'LIVE' : 'scripted'} corpus...\n`);
  const report = await runCorpus(tenantId, EVAL_CASES, { live });
  const { results } = report;

  for (const result of results) {
    console.log(`${result.passed ? '  PASS' : '  FAIL'}  ${result.name}`);
    if (!result.passed) {
      console.log(`        why it exists: ${result.intent}`);
      for (const failure of result.failures) console.log(`        - ${failure}`);
      if (result.toolsUsed.length > 0) {
        console.log(`        tools called: ${result.toolsUsed.join(', ')}`);
      }
    } else if (live && result.toolsUsed.length > 0) {
      // On a passing live case the tool choices are the interesting part —
      // they are what the scripted corpus cannot measure.
      console.log(`        tools called: ${result.toolsUsed.join(', ')}`);
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
