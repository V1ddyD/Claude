import 'server-only';
import { sql } from 'drizzle-orm';
import { withoutTenantScope, withTenant, type TenantDb } from '@/server/db/tenant-db';
import { tenantSettings } from '@/server/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Rate limiting and spend.
 *
 * Both were previously in-process: a Map that every serverless instance had its
 * own copy of, and a budget that was configured but never read. On a public
 * endpoint that calls a paid model, neither is a detail.
 *
 * The counter lives in Postgres so the limit is the same limit whichever
 * instance answers, and survives a restart.
 */

export interface RateLimit {
  bucket: string;
  /** Opaque: a visitor id, a hashed IP. Never an email or a name. */
  subject: string;
  max: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(limit: RateLimit): Promise<RateLimitResult> {
  const windowMs = limit.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);

  // One statement: insert the window or increment it, returning the new count.
  // Two concurrent requests cannot both read "0" and both write "1".
  const rows = (await withoutTenantScope('worker', (db) =>
    db.execute(sql`
      INSERT INTO rate_limit_counters (bucket, subject, window_start, count)
      VALUES (${limit.bucket}, ${limit.subject}, ${windowStart}, 1)
      ON CONFLICT (bucket, subject, window_start)
        DO UPDATE SET count = rate_limit_counters.count + 1
      RETURNING count
    `),
  )) as unknown as Array<{ count: number }>;

  const count = rows[0]?.count ?? 1;
  const nextWindow = windowStart.getTime() + windowMs;

  return {
    allowed: count <= limit.max,
    remaining: Math.max(0, limit.max - count),
    retryAfterSeconds: Math.max(1, Math.ceil((nextWindow - Date.now()) / 1000)),
  };
}

/** Removes windows that have closed. Run by the worker. */
export async function sweepRateLimits(): Promise<number> {
  const rows = (await withoutTenantScope('worker', (db) =>
    db.execute(sql`
      DELETE FROM rate_limit_counters
      WHERE window_start < now() - interval '1 day'
      RETURNING 1
    `),
  )) as unknown as unknown[];
  return rows.length;
}

/**
 * Whether this dealership has AI budget left this month.
 *
 * Over budget degrades the assistant to the contact form rather than failing:
 * a customer must never see a billing problem, and an enquiry must still reach
 * the dealership.
 */
export async function hasAiBudget(tenantId: string): Promise<boolean> {
  return withTenant(tenantId, async (db) => {
    const [settings] = await db
      .select({ ai: tenantSettings.ai })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, db.tenantId))
      .limit(1);

    const budget = (settings?.ai as { monthlyTokenBudget?: number } | undefined)
      ?.monthlyTokenBudget;
    // No configured budget means no ceiling, which is a deliberate choice a
    // dealership makes rather than a default we impose.
    if (!budget) return true;

    const rows = (await db.execute(sql`
      SELECT coalesce(input_tokens + output_tokens, 0) AS used
      FROM ai_usage WHERE tenant_id = ${tenantId} AND period = ${currentPeriod()}
    `)) as unknown as Array<{ used: number }>;

    return Number(rows[0]?.used ?? 0) < budget;
  });
}

/** Records what a turn cost. Called after the model responds, never before. */
export async function recordAiUsage(
  db: TenantDb,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO ai_usage (tenant_id, period, input_tokens, output_tokens, requests)
    VALUES (${db.tenantId}, ${currentPeriod()}, ${usage.inputTokens}, ${usage.outputTokens}, 1)
    ON CONFLICT (tenant_id, period) DO UPDATE SET
      input_tokens = ai_usage.input_tokens + EXCLUDED.input_tokens,
      output_tokens = ai_usage.output_tokens + EXCLUDED.output_tokens,
      requests = ai_usage.requests + 1,
      updated_at = now()
  `);
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}
