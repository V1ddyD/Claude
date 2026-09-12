import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { sql } from 'drizzle-orm';
import { unscopedDb } from '@/server/db/client';
import { withoutTenantScope } from '@/server/db/tenant-db';
import { env, features } from '@/server/config/env';

/**
 * What this deployment can actually do.
 *
 * Written because a deployed instance returning 500 on every page gives you
 * nothing to work with: the cause is a missing variable, an unreachable
 * database, an unmigrated one or an unregistered hostname, and from outside
 * they are indistinguishable.
 *
 * Everything here is a boolean or a count. No connection string, no secret, no
 * hostname belonging to another dealership, no error text from the driver —
 * the answer to "is it configured" must not itself disclose the
 * configuration.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const host = (await headers()).get('host') ?? '';

  const report = {
    ok: false,
    // Every one of these reads validated configuration, which THROWS when the
    // configuration is incomplete — and incomplete configuration is the exact
    // case this endpoint exists to report. An unhandled throw here returns 500
    // with an empty body, which is indistinguishable from the failure it was
    // meant to explain. So each is read defensively.
    assistant: tolerate(() => features.aiProvider, 'unknown'),
    email: tolerate(() => (features.email ? 'configured' : 'not configured'), 'unknown'),
    demo: tolerate(() => features.demoPortal, false),
    database: {
      configured: hasDatabaseUrl(),
      reachable: false,
      migrated: false,
      seeded: false,
    },
    /** Whether THIS hostname maps to a dealership. Never which one. */
    hostRecognised: false,
  };

  if (!report.database.configured) return NextResponse.json(report, { status: 503 });

  try {
    await withoutTenantScope('health', async () => {
      await unscopedDb.execute(sql`SELECT 1`);
    });
    report.database.reachable = true;
  } catch {
    // Deliberately swallowed. A driver error names the host and the role.
    return NextResponse.json(report, { status: 503 });
  }

  try {
    const [migrated] = (await withoutTenantScope('health', () =>
      unscopedDb.execute(sql`
        SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'vehicle_models'
      `),
    )) as unknown as { count: number }[];
    report.database.migrated = Number(migrated?.count ?? 0) > 0;
  } catch {
    return NextResponse.json(report, { status: 503 });
  }

  if (!report.database.migrated) return NextResponse.json(report, { status: 503 });

  try {
    const [counts] = (await withoutTenantScope('health', () =>
      unscopedDb.execute(sql`
        SELECT (SELECT count(*)::int FROM vehicle_models) AS models,
               (SELECT count(*)::int FROM tenant_domains WHERE hostname = ${host.toLowerCase()}) AS host
      `),
    )) as unknown as { models: number; host: number }[];

    report.database.seeded = Number(counts?.models ?? 0) > 0;
    report.hostRecognised = Number(counts?.host ?? 0) > 0;
  } catch {
    return NextResponse.json(report, { status: 503 });
  }

  report.ok = report.database.seeded && report.hostRecognised;
  return NextResponse.json(report, { status: report.ok ? 200 : 503 });
}

/**
 * Whether a database is configured at all.
 *
 * Through the validated config, and tolerant of it refusing to load: reporting
 * "not configured" is the useful answer to exactly the case where reading the
 * configuration would throw.
 */
function hasDatabaseUrl(): boolean {
  return tolerate(() => Boolean(env.DATABASE_URL), false);
}

/** Reading configuration that may refuse to load, without becoming a 500. */
function tolerate<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
