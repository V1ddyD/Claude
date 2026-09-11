/**
 * Onboard a dealership from a configuration file.
 *
 *   npm run onboard -- dealerships/northwind.example.json
 *
 * This is the whole process. A new dealership is rows, not a release: no code
 * change, no migration, no deploy. It is also the M6 exit criterion — if this
 * cannot bring a second dealership up, the multi-tenant claim is not true.
 */
import { readFileSync } from 'node:fs';
import { loadEnvFile } from '../src/server/config/load-env-file';

loadEnvFile('.env.local', '.env.test.local');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run onboard -- <config.json>');
    process.exit(1);
  }

  const { onboardDealership } = await import('../src/server/services/onboarding');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const result = await onboardDealership(config);

  console.log(
    `${result.created ? 'Created' : 'Updated'} ${result.slug} (${result.tenantId}).`,
  );
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
  console.log(
    '\nThe dealership is live on its hostnames. It has no catalogue yet — add\n' +
      'vehicles through the same seed path Sinclair uses.',
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
