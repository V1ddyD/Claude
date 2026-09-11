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

  if (live && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      'Live mode needs ANTHROPIC_API_KEY. This is the operator\'s key, set once in\n' +
        '.env.local — it is never something a customer supplies.',
    );
    process.exit(1);
  }

  console.log(`Running the ${live ? 'LIVE' : 'scripted'} corpus...\n`);
  const results = await runCorpus(tenantId, EVAL_CASES, { live });

  for (const result of results) {
    console.log(`${result.passed ? '  PASS' : '  FAIL'}  ${result.name}`);
    if (!result.passed) {
      console.log(`        why it exists: ${result.intent}`);
      for (const failure of result.failures) console.log(`        - ${failure}`);
      if (result.toolsUsed.length > 0) {
        console.log(`        tools called: ${result.toolsUsed.join(', ')}`);
      }
    }
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed.`);

  await closeConnections();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
