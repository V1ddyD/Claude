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

export async function migrate(connectionString: string, opts: { quiet?: boolean } = {}) {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const log = (msg: string) => {
    if (!opts.quiet) console.log(msg);
  };

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `;

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied = await sql<{ name: string; checksum: string }[]>`
      SELECT name, checksum FROM schema_migrations
    `;
    const appliedByName = new Map(applied.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
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

    log(`  up to date (${files.length} migration${files.length === 1 ? '' : 's'})`);
  } finally {
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
