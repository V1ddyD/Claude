/**
 * Measures the real request payload, so a live evaluation's cost can be
 * estimated before spending anything on it.
 *
 * Approximate by design: it counts characters and applies a conservative
 * ratio rather than calling the token counter, which itself needs a key.
 * Treat the figure as an upper bound on the order of magnitude, not a quote.
 */
import { loadEnvFile } from '../src/server/config/load-env-file';
loadEnvFile('.env.local', '.env.test.local');

async function main() {
  const { toolRegistry } = await import('../src/server/ai/tools');
  const { buildSystemPrompt } = await import('../src/server/ai/prompts/system');
  const { listActiveTenantIds } = await import('../src/server/db/control-plane');
  const { withTenant } = await import('../src/server/db/tenant-db');
  const { closeConnections } = await import('../src/server/db/client');
  const { vehicleModels } = await import('../src/server/db/schema');
  const { eq, and } = await import('drizzle-orm');

  const [tenantId] = await listActiveTenantIds();
  if (!tenantId) throw new Error('Seed the database first.');

  const digest = await withTenant(tenantId, async (db) => {
    const models = await db
      .select({ full: vehicleModels.fullName, segment: vehicleModels.segment })
      .from(vehicleModels)
      .where(and(eq(vehicleModels.tenantId, db.tenantId), eq(vehicleModels.status, 'published')));
    return models.map((m) => `- ${m.full} — ${m.segment}, from $00,000`).join('\n');
  });

  const system = buildSystemPrompt({
    brandName: 'Sinclair',
    timezone: 'America/Toronto',
    locale: 'en-CA',
    currency: 'CAD',
    catalogueDigest: digest,
    responseSlaHours: 1,
    knownFacts: ['Interested in the S5', 'Budget around 55,000'],
    earlier: 'Earlier in this conversation: looking at the S5 Premium.',
    nowLocal: 'Friday, 11 September 2026',
  });

  const tools = JSON.stringify(toolRegistry().schemas());

  // ~3.6 characters per token is conservative for English prose; JSON schemas
  // are denser, so this over-estimates rather than under-estimates.
  const toTokens = (text: string) => Math.ceil(text.length / 3.6);

  const systemTokens = toTokens(system);
  const toolTokens = toTokens(tools);
  const perRequestInput = systemTokens + toolTokens;

  console.log('Measured request payload');
  console.log(`  system prompt     ${system.length.toLocaleString()} chars  ~${systemTokens.toLocaleString()} tokens`);
  console.log(`  tool definitions  ${tools.length.toLocaleString()} chars  ~${toolTokens.toLocaleString()} tokens`);
  console.log(`  fixed prefix      ~${perRequestInput.toLocaleString()} tokens per request`);
  console.log(`  tools defined     ${toolRegistry().list().length}`);

  // A live corpus case is a few turns, each turn 1-3 model requests.
  const cases = 12;
  const requestsPerCase = 2.5;
  const outputPerRequest = 300;
  const requests = Math.round(cases * requestsPerCase);

  const inputTokens = requests * (perRequestInput + 400);
  const outputTokens = requests * outputPerRequest;
  const cold = (inputTokens / 1e6) * 5 + (outputTokens / 1e6) * 25;
  // The system prompt and tool list are marked cacheable, so repeat requests
  // read the prefix at roughly a tenth of the input rate.
  const warm = ((inputTokens * 0.15) / 1e6) * 5 + (outputTokens / 1e6) * 25;

  console.log('\nEstimated cost of one full live corpus run (Opus 5: $5/$25 per MTok)');
  console.log(`  ~${requests} requests, ~${inputTokens.toLocaleString()} in / ~${outputTokens.toLocaleString()} out`);
  console.log(`  without prompt caching   ~$${cold.toFixed(3)}`);
  console.log(`  with prompt caching      ~$${warm.toFixed(3)}`);
  console.log(`  hard cap in the runner    $2.00`);

  await closeConnections();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
