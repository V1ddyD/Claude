import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { prepareDatabase, adminConnection } from '../helpers/db';
import * as schema from '../../src/server/db/schema';

/**
 * The SQL migrations are the source of truth; the Drizzle definitions exist to
 * type queries. Nothing keeps them in step automatically, so this asserts it.
 *
 * Without this, a column renamed in SQL produces a runtime error in whichever
 * feature happens to read it first, in whichever environment happens to run it.
 */

let admin: Sql;
beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
});

type TableConfigOf = ReturnType<typeof getTableConfig>;

function definedTables(): TableConfigOf[] {
  const configs: TableConfigOf[] = [];
  for (const value of Object.values(schema)) {
    if (typeof value !== 'object' || value === null) continue;
    try {
      configs.push(getTableConfig(value as never));
    } catch {
      // Not a table export (a type helper, an enum, a custom column type).
    }
  }
  return configs;
}

describe('drizzle definitions', () => {
  it('reference tables that exist', async () => {
    const actual = await admin<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const existing = new Set(actual.map((r) => r.table_name));
    const missing = definedTables().map((t) => t.name).filter((n) => !existing.has(n));
    expect(missing).toEqual([]);
  });

  it('reference columns that exist, with matching nullability', async () => {
    const columns = await admin<
      { table_name: string; column_name: string; is_nullable: string }[]
    >`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public'
    `;

    const byTable = new Map<string, Map<string, boolean>>();
    for (const c of columns) {
      if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Map());
      byTable.get(c.table_name)!.set(c.column_name, c.is_nullable === 'YES');
    }

    const problems: string[] = [];
    for (const table of definedTables()) {
      const actual = byTable.get(table.name);
      if (!actual) continue;
      for (const col of table.columns) {
        const nullableInDb = actual.get(col.name);
        if (nullableInDb === undefined) {
          problems.push(`${table.name}.${col.name} is defined but does not exist`);
          continue;
        }
        // A column the database allows to be null, typed as non-null in code,
        // makes every read of it a lie the type checker endorses.
        if (nullableInDb && col.notNull) {
          problems.push(`${table.name}.${col.name} is nullable in the database but notNull in code`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
