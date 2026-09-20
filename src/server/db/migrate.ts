/**
 * Migration runner.
 *
 * Forward-only, applied in filename order, each in its own transaction, tracked
 * in `schema_migrations`. Runs as the OWNER role (DATABASE_ADMIN_URL), never as
 * the request-path role.
 *
 * Deliberately not drizzle-kit: the SQL in db/migrations is the source of truth
 * and is reviewed as SQL. Generating DDL from TypeScript definitions would make
 * the constraints that carry the safety guarantees — the exclusion constraint,
 * the composite foreign keys, the RLS policies — implicit and easy to lose.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { loadEnvFile } from './../config/load-env-file';

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');

export interface MigrationSource {
  name: string;
  sql: string;
}

/**
 * Where the migrations come from.
 *
 * The CLI reads `db/migrations` from disk, which is the source of truth. A
 * serverless function cannot — its working directory is not the repository —
 * so it passes the compiled-in copy instead. Same runner, same tracking table,
 * same immutability check either way.
 */
/**
 * A fixed advisory-lock key, so only one migration runs at a time.
 *
 * Nothing needed this while migrations were a thing a person ran at a
 * terminal. Once a deployment applies its own, several instances can start at
 * once and all reach for the same CREATE TABLE — one wins, the rest fail on a
 * relation that already exists, and a cold start becomes an outage.
 *
 * The lock is held on the session, so it is released even if the process dies
 * mid-migration; the loser then wakes, re-reads schema_migrations and finds
 * there is nothing left to do.
 */
const MIGRATION_LOCK = 8274531109;

export async function migrate(
  connectionString: string,
  opts: { quiet?: boolean; migrations?: MigrationSource[] } = {},
) {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const log = (msg: string) => {
    if (!opts.quiet) console.log(msg);
  };

  try {
    // Before anything is read or written: the applied-set is only meaningful
    // while nobody else is changing it.
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;

    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `;

    const sources =
      opts.migrations ??
      (await Promise.all(
        (await readdir(MIGRATIONS_DIR))
          .filter((f) => f.endsWith('.sql'))
          .sort()
          .map(async (name) => ({ name, sql: await readFile(join(MIGRATIONS_DIR, name), 'utf8') })),
      ));

    const applied = await sql<{ name: string; checksum: string }[]>`
      SELECT name, checksum FROM schema_migrations
    `;
    const appliedByName = new Map(applied.map((r) => [r.name, r.checksum]));

    for (const { name: file, sql: body } of sources) {
      const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16);
      const previous = appliedByName.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          // An applied migration was edited. Silently ignoring this is how
          // environments drift apart without anyone noticing.
          throw new Error(
            `Migration ${file} has changed since it was applied ` +
              `(${previous} -> ${checksum}). Migrations are immutable; add a new one.`,
          );
        }
        continue;
      }

      log(`  applying ${file}`);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${file}, ${checksum})`;
      });
    }

    log(`  up to date (${sources.length} migration${sources.length === 1 ? '' : 's'})`);
  } finally {
    // Ending the connection would release it anyway; released explicitly so a
    // pooled or reused connection cannot carry the lock away with it.
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

// Entry point for `npm run db:migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnvFile();
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_ADMIN_URL (or DATABASE_URL) must be set');
    process.exit(1);
  }
  console.log('Running migrations...');
  migrate(url).then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
