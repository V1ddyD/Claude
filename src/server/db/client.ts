import 'server-only';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env, isProduction } from '@/server/config/env';

/**
 * The ONLY module permitted to open a database connection.
 * Enforced by an ESLint restricted-import rule; see eslint.config.mjs.
 *
 * Two pools, with deliberately different privileges:
 *
 *   request path -> DATABASE_URL, role `app_user`, subject to RLS
 *   migrations   -> DATABASE_ADMIN_URL, owner role, never used to serve a request
 *
 * Handing the request path an owner or BYPASSRLS role would silently disable
 * tenant isolation while every test still passed, so the split is structural.
 */

const shared = {
  max: isProduction ? 10 : 4,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false, // required for transaction-pooled connections (Supabase pgBouncer)
  onnotice: () => {},
} as const;

declare global {
  // Next.js dev server reloads modules; without this each reload leaks a pool.
  var __sinclair_sql__: postgres.Sql | undefined;
}

/**
 * The pool is opened on first use, not on import.
 *
 * `next build` imports server modules to collect route configuration; opening a
 * connection at import time would make every build need a reachable database.
 */
let pool: postgres.Sql | undefined;

function getPool(): postgres.Sql {
  if (pool) return pool;
  pool = globalThis.__sinclair_sql__ ?? postgres(env.DATABASE_URL, shared);
  if (!isProduction) globalThis.__sinclair_sql__ = pool;
  return pool;
}

type Db = ReturnType<typeof drizzle>;
let db: Db | undefined;

function getDb(): Db {
  db ??= drizzle(getPool());
  return db;
}

/**
 * Unscoped database handle.
 *
 * Do not import this outside `src/server/db/**`. Every query that touches tenant
 * data must go through `withTenant()`, which establishes the Postgres context
 * that RLS reads. This handle exists for migrations, tenant resolution and
 * health checks only.
 */
export const unscopedDb = new Proxy({} as Db, {
  get: (_t, key: string | symbol) => {
    const value = getDb()[key as keyof Db];
    return typeof value === 'function' ? value.bind(getDb()) : value;
  },
});

export function createAdminConnection(): postgres.Sql {
  const url = env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL is not configured');
  return postgres(url, { ...shared, max: 1 });
}

export async function closeConnections(): Promise<void> {
  await pool?.end({ timeout: 5 });
  pool = undefined;
  db = undefined;
  globalThis.__sinclair_sql__ = undefined;
}
