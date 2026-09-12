/**
 * Generate the migration set Netlify applies on deploy.
 *
 *   npm run netlify:migrations
 *
 * Netlify applies SQL from `netlify/database/migrations/` immediately before a
 * deploy is published, which is how the hosted demonstration provisions its own
 * database: there is no connection string to reach it with from outside.
 *
 * `db/migrations/` stays the single source of truth. This copies it, adds one
 * final migration carrying the seeded demonstration data, and writes a manifest
 * so `tests/schema/netlify-migrations.test.ts` can prove the copies have not
 * drifted from the originals.
 *
 * The seed migration is generated from a real seeded database rather than
 * written by hand — the catalogue is 10 models, 36 configurations and 86
 * inventory units, and a hand-maintained copy of that would be wrong within a
 * week.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = 'db/migrations';
const TARGET = 'netlify/database/migrations';
const MANIFEST = join(TARGET, 'manifest.json');

/**
 * Tables left out of the seed dump.
 *
 * Two kinds: what the schema migrations already populate, and what people did.
 * A demonstration starts with a catalogue, staff and stock — not with
 * conversations, leads or appointments belonging to whoever was testing it when
 * the dump was taken.
 */
const EXCLUDED = [
  // Populated by the schema migrations themselves — the permission matrix and
  // the inventory state machine are part of the schema, not of a dealership.
  // Dumping them too would re-insert rows that already exist.
  'role_permissions', 'inventory_transitions',

  'schema_migrations', 'visitors', 'conversations', 'messages', 'customers',
  'leads', 'lead_signals', 'lead_events', 'staff_notes', 'appointments',
  'appointment_resources', 'tickets', 'email_messages', 'job_queue',
  'audit_logs', 'follow_up_tasks', 'notifications', 'trade_in_requests',
  'finance_requests', 'saved_builds', 'rate_limit_counters', 'access_tokens',
  'ai_usage',
];

function slug(filename: string): string {
  return filename.replace(/\.sql$/, '').replace(/^\d+_/, '').replace(/_/g, '-');
}

/**
 * The tables to seed, ordered so every row's references already exist.
 *
 * Read out of the database rather than listed here: a catalogue table added
 * next month would otherwise be silently left out of the demonstration, and
 * nothing would fail until someone clicked on it.
 */
function seedTablesInOrder(adminUrl: string): string[] {
  const query = `
    SELECT c.relname AS table_name,
           coalesce(array_agg(DISTINCT f.relname) FILTER (WHERE f.relname IS NOT NULL), '{}') AS depends_on
    FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_constraint con
        ON con.conrelid = c.oid AND con.contype = 'f'
      LEFT JOIN pg_class f
        ON f.oid = con.confrelid AND f.oid <> c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    GROUP BY c.relname
    ORDER BY c.relname
  `;

  const raw = execFileSync('psql', [adminUrl, '-tAF', '\t', '-c', query], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  const dependencies = new Map<string, string[]>();
  for (const line of raw.split('\n').filter(Boolean)) {
    const [table, deps] = line.split('\t');
    if (!table || EXCLUDED.includes(table)) continue;
    dependencies.set(
      table,
      (deps ?? '{}').replace(/^\{|\}$/g, '').split(',').filter(Boolean),
    );
  }

  // Depth-first, so a table is emitted only once everything it points at has
  // been. Cycles are impossible in this schema and would simply be emitted in
  // discovery order if one appeared.
  const ordered: string[] = [];
  const seen = new Set<string>();

  const visit = (table: string) => {
    if (seen.has(table)) return;
    seen.add(table);
    for (const dependency of dependencies.get(table) ?? []) {
      if (dependencies.has(dependency)) visit(dependency);
    }
    ordered.push(table);
  };

  for (const table of dependencies.keys()) visit(table);
  return ordered;
}

/** psql meta-commands are not SQL, and the migration runner is not psql. */
function stripMetaCommands(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\\(restrict|unrestrict|connect|encoding)\b/.test(line))
    .join('\n');
}

function dumpInDependencyOrder(adminUrl: string): string {
  const chunks: string[] = [];

  for (const table of seedTablesInOrder(adminUrl)) {
    const chunk = execFileSync(
      'pg_dump',
      [
        adminUrl, '--data-only', '--inserts', '--no-owner', '--no-privileges',
        '--table', `public.${table}`,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    const inserts = stripMetaCommands(chunk)
      .split('\n')
      .filter((line) => line.startsWith('INSERT INTO') || line.startsWith('SELECT pg_catalog.setval'))
      .join('\n');

    if (inserts.trim().length > 0) chunks.push(`-- ${table}\n${inserts}`);
  }

  return chunks.join('\n\n');
}

function main() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.error(
      'DATABASE_ADMIN_URL must point at a freshly migrated and seeded database.\n' +
        'The seed migration is dumped from it.',
    );
    process.exit(1);
  }

  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });

  const manifest: Record<string, string> = {};
  const files = readdirSync(SOURCE).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = readFileSync(join(SOURCE, file), 'utf8');
    const number = /^(\d+)_/.exec(file)![1]!;
    const dir = join(TARGET, `${number}_${slug(file)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'migration.sql'), sql);
    manifest[file] = createHash('sha256').update(sql).digest('hex');
  }

  // The seed, dumped as data-only INSERTs. Netlify applies each migration once,
  // so this does not need to be idempotent — and INSERTs rather than COPY so a
  // failure names the row rather than the batch.
  //
  // Dumped table by table in dependency order. pg_dump emits tables
  // alphabetically, which puts `colours` before the `vehicle_models` its rows
  // reference; the usual answer is `--disable-triggers`, which needs privileges
  // a managed database will not give you. Ordering the inserts needs none.
  const dump = dumpInDependencyOrder(adminUrl);

  const seedDir = join(TARGET, '0100_seed-demonstration-dealership');
  mkdirSync(seedDir, { recursive: true });
  writeFileSync(
    join(seedDir, 'migration.sql'),
    '-- Generated by scripts/build-netlify-migrations.ts. Do not edit by hand.\n' +
      '-- The demonstration dealership: catalogue, staff, hours, stock and rules.\n' +
      '-- Regenerate with `npm run netlify:migrations`.\n\n' +
      dump,
  );
  manifest['__seed_rows'] = String((dump.match(/^INSERT INTO/gm) ?? []).length);

  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `Wrote ${files.length} schema migrations and a seed of ${manifest['__seed_rows']} rows to ${TARGET}.`,
  );
}

main();
