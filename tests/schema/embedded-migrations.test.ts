import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDED_MIGRATIONS } from '../../src/server/db/migrations.generated';

/**
 * The compiled-in copy of the migrations.
 *
 * A serverless function's working directory is not the repository, so it
 * cannot read `db/migrations` from disk — the SQL is compiled in instead, and
 * the hosted database is migrated from that copy.
 *
 * A second copy of a schema is a liability. `db/migrations/` remains the
 * single source of truth; these assertions are what stop the copy drifting,
 * which would show up as a deployed database a migration behind its code and
 * nothing failing until a query hit the missing column.
 */

const SOURCE = 'db/migrations';
const files = readdirSync(SOURCE).filter((f) => f.endsWith('.sql')).sort();
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

describe('the embedded migrations', () => {
  it('include every migration, in order, and no others', () => {
    expect(EMBEDDED_MIGRATIONS.map((m) => m.name)).toEqual(files);
  });

  it.each(files)('%s is byte-identical to the file', (file) => {
    const original = readFileSync(join(SOURCE, file), 'utf8');
    const embedded = EMBEDDED_MIGRATIONS.find((m) => m.name === file);

    expect(embedded, `${file} is missing — run \`npm run migrations:embed\``).toBeDefined();
    expect(embedded!.sql).toBe(original);
    expect(embedded!.checksum).toBe(digest(original));
  });

  it('carries the things the schema exists for', () => {
    const all = EMBEDDED_MIGRATIONS.map((m) => m.sql).join('\n');

    // The guarantees that are constraints rather than code. If the embedded
    // copy lost these, a deployed database would isolate nothing and could
    // double-book a car, while every test here still passed.
    expect(all).toContain('FORCE ROW LEVEL SECURITY');
    expect(all).toContain('EXCLUDE USING gist');
    expect(all).toContain('CREATE ROLE app_user');
    expect(all).toMatch(/app\.current_tenant_id\(\)/);
  });
});
