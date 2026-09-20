import 'server-only';
import { migrate } from './migrate';
import { EMBEDDED_MIGRATIONS } from './migrations.generated';
import { env, features } from '@/server/config/env';

/**
 * Apply pending migrations when a server instance starts.
 *
 * The problem this solves: code and schema deploy together but were applied
 * separately. A build that adds a column shipped fine, and every request then
 * asked the database for a column it did not have. Nothing in the deployment
 * was wrong — the step that was missing was one somebody had to remember.
 *
 * Three things keep it from being reckless:
 *
 *   an explicit opt-in   a deployment holding a real dealership's data should
 *                        migrate under supervision, not on a cold start
 *   an advisory lock     several instances start at once; one migrates and the
 *                        rest wait, rather than racing on CREATE TABLE
 *   idempotence          after the first, it is one SELECT against
 *                        schema_migrations
 *
 * Failure is logged and swallowed. A migration that cannot be applied is
 * already going to break the request that needs it, with an error that names
 * the actual problem; throwing here would replace that with a dead instance
 * and no explanation.
 */

/** Once per instance, not once per request. */
let started: Promise<void> | undefined;

export function autoMigrate(): Promise<void> {
  started ??= run();
  return started;
}

async function run(): Promise<void> {
  if (!shouldMigrate()) return;

  // The owner credential. `DATABASE_URL` is the fallback because a managed
  // platform often issues one role that owns the tables — the same reasoning
  // as the bootstrap route, which cannot be reached from a cold start.
  const url = env.DATABASE_ADMIN_URL ?? env.DATABASE_URL;
  if (!url) return;

  try {
    // The compiled-in copy: a serverless function's working directory is not
    // the repository, so the SQL cannot be read from disk here.
    //
    // Silent on success, deliberately: this runs on every cold start and is a
    // single SELECT once the schema is current. /api/health is where to ask
    // whether the database is migrated.
    await migrate(url, { quiet: true, migrations: EMBEDDED_MIGRATIONS });
  } catch (error) {
    console.error('[migrate] could not apply migrations', error);
  }
}

/**
 * Whether this deployment migrates itself.
 *
 * `AUTO_MIGRATE` decides when set, either way. Otherwise a demonstration
 * deployment does — it is already the deployment that seeds itself and hands
 * out a shared password, and it has no operator standing by — and anything
 * else does not.
 */
function shouldMigrate(): boolean {
  if (env.AUTO_MIGRATE === 'true') return true;
  if (env.AUTO_MIGRATE === 'false') return false;
  return features.demoPortal;
}

/** Test seam: lets a test observe a fresh decision. */
export function resetAutoMigrateForTests(): void {
  started = undefined;
}

/** Test seam. The decision itself, without connecting to anything. */
export function shouldMigrateForTests(): boolean {
  return shouldMigrate();
}
