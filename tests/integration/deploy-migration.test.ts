import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { ADMIN_URL } from '../helpers/db';
import { migrate } from '../../src/server/db/migrate';
import { EMBEDDED_MIGRATIONS } from '../../src/server/db/migrations.generated';

/**
 * A deployment applying its own schema.
 *
 * Written after a real outage: code needing `conversations.handed_off_at`
 * shipped, the column was never added to the live database, and every chat
 * turn asked for something that did not exist. Nothing in the deployment was
 * wrong — the missing step was one a person had to remember.
 *
 * So these run against genuinely empty databases, created and dropped here,
 * rather than against the shared test database that is already migrated. A
 * database that is already correct cannot prove that getting it correct works.
 */

let root: Sql;
const created: string[] = [];

/** A fresh, empty database, and the URL to reach it. */
async function freshDatabase(label: string): Promise<string> {
  const name = `sinclair_deploy_${label}_${Math.random().toString(36).slice(2, 8)}`;
  await root.unsafe(`CREATE DATABASE ${name}`);
  created.push(name);
  return ADMIN_URL.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}

beforeAll(() => {
  root = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  for (const name of created) {
    await root.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  }
  await root?.end({ timeout: 5 });
});

describe('migrating from empty', () => {
  it('produces every column the running code asks for', async () => {
    const url = await freshDatabase('cold');

    // Exactly what a cold start does: the compiled-in copy, because a
    // serverless function's working directory is not the repository.
    await migrate(url, { quiet: true, migrations: EMBEDDED_MIGRATIONS });

    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const columns = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'conversations'
      `;
      const names = columns.map((c) => c.column_name);

      // The two that took the site down.
      expect(names).toContain('handed_off_at');
      expect(names).toContain('handed_off_to');

      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'channel_%'
      `;
      expect(tables.map((t) => t.table_name).sort()).toEqual([
        'channel_accounts',
        'channel_identities',
        'channel_inbound_messages',
        'channel_messages',
      ]);

      // The unscoped resolution surface an inbound webhook reads before it
      // can know which dealership it belongs to.
      const views = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.views
        WHERE table_schema = 'public' AND table_name = 'v_channel_account_lookup'
      `;
      expect(views).toHaveLength(1);

      // A conversation may now say where it came from.
      const [check] = await sql<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'conversations_channel_check'
      `;
      expect(check?.definition).toContain('instagram');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('heals a database left behind by an earlier deploy', async () => {
    const url = await freshDatabase('behind');

    // Exactly the state production was in: every migration up to the one that
    // shipped with the handover feature, and not that one.
    const behind = EMBEDDED_MIGRATIONS.filter((m) => !m.name.startsWith('0007'));
    expect(behind.length).toBe(EMBEDDED_MIGRATIONS.length - 1);
    await migrate(url, { quiet: true, migrations: behind });

    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const missing = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'conversations'
          AND column_name = 'handed_off_at'
      `;
      // The outage, reproduced: the running code asks for this and it is not
      // there, so every chat turn fails.
      expect(missing).toHaveLength(0);

      // What a request now does before it touches the database.
      await migrate(url, { quiet: true, migrations: EMBEDDED_MIGRATIONS });

      const healed = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'conversations'
          AND column_name = 'handed_off_at'
      `;
      expect(healed).toHaveLength(1);

      // And the earlier migrations were not re-applied on the way past.
      const [count] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM schema_migrations
      `;
      expect(count?.n).toBe(EMBEDDED_MIGRATIONS.length);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('applies everything exactly once when instances start together', async () => {
    const url = await freshDatabase('race');

    // Several serverless instances waking at the same moment. Without the
    // advisory lock they all reach for the same CREATE TABLE: one wins and
    // the rest fail on a relation that already exists, turning a cold start
    // into an outage.
    const results = await Promise.allSettled([
      migrate(url, { quiet: true, migrations: EMBEDDED_MIGRATIONS }),
      migrate(url, { quiet: true, migrations: EMBEDDED_MIGRATIONS }),
      migrate(url, { quiet: true, migrations: EMBEDDED_MIGRATIONS }),
    ]);

    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason));
    expect(failures).toEqual([]);

    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const applied = await sql<{ name: string; count: number }[]>`
        SELECT name, count(*)::int FROM schema_migrations GROUP BY name
      `;
      // One row per migration, not three.
      expect(applied).toHaveLength(EMBEDDED_MIGRATIONS.length);
      expect(applied.every((row) => row.count === 1)).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('is a no-op the second time, and says so without touching anything', async () => {
    const url = await freshDatabase('again');

    await migrate(url, { quiet: true, migrations: EMBEDDED_MIGRATIONS });

    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const [before] = await sql<{ at: Date }[]>`
        SELECT max(applied_at) AS at FROM schema_migrations
      `;

      await migrate(url, { quiet: true, migrations: EMBEDDED_MIGRATIONS });

      const [after] = await sql<{ at: Date }[]>`
        SELECT max(applied_at) AS at FROM schema_migrations
      `;
      // Nothing re-applied: every cold start after the first costs one SELECT.
      expect(after?.at?.getTime()).toBe(before?.at?.getTime());
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses to run a migration that was edited after it was applied', async () => {
    const url = await freshDatabase('edited');

    await migrate(url, { quiet: true, migrations: EMBEDDED_MIGRATIONS });

    const tampered = EMBEDDED_MIGRATIONS.map((m, i) =>
      i === 0 ? { ...m, sql: `${m.sql}\n-- edited after the fact` } : m,
    );

    // Environments drift apart silently when this is tolerated. A deployment
    // that migrates itself makes that worse, not better — so it still stops.
    await expect(migrate(url, { quiet: true, migrations: tampered })).rejects.toThrow(
      /Migrations are immutable/,
    );
  });
});
