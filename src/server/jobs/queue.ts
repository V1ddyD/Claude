import 'server-only';
import { sql } from 'drizzle-orm';
import { jobQueue } from '@/server/db/schema';
import { withoutTenantScope, type TenantDb } from '@/server/db/tenant-db';

/**
 * Postgres-backed job queue.
 *
 * docs/00-architecture.md §10: one queue, drained by a cron-invoked worker. No
 * external workflow engine — every automation here is a database-triggered job
 * needing tenant-scoped authorization, which an outside engine makes harder to
 * audit, not easier.
 */

export type JobKind =
  | 'extract_and_score'
  | 'send_email'
  | 'evaluate_follow_ups'
  | 'expire_holds';

export interface Job {
  id: string;
  tenantId: string | null;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Enqueue inside the caller's transaction.
 *
 * Taking a TenantDb rather than opening its own connection is the point: a job
 * scheduled for work that rolls back must roll back with it.
 */
export async function enqueue(
  db: TenantDb,
  kind: JobKind,
  payload: Record<string, unknown>,
  options: { runAt?: Date } = {},
): Promise<void> {
  await db.insert(jobQueue).values({
    tenantId: db.tenantId,
    kind,
    payload: payload as never,
    runAt: options.runAt ?? new Date(),
  });
}

/**
 * Claim a batch of due jobs.
 *
 * FOR UPDATE SKIP LOCKED lets several workers run concurrently without any two
 * claiming the same job, and without one long job blocking the queue behind it.
 */
export async function claimJobs(limit = 10, workerId = 'worker'): Promise<Job[]> {
  return withoutTenantScope('worker', async (db) => {
    const rows = (await db.execute(sql`
      UPDATE job_queue SET
        status = 'running',
        locked_by = ${workerId},
        locked_at = now(),
        attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM job_queue
        WHERE status = 'pending' AND run_at <= now()
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id, tenant_id AS "tenantId", kind, payload, attempts
    `)) as unknown as Job[];
    return rows;
  });
}

export async function completeJob(jobId: string): Promise<void> {
  await withoutTenantScope('worker', async (db) => {
    await db.execute(sql`UPDATE job_queue SET status = 'done', locked_by = NULL WHERE id = ${jobId}`);
  });
}

/**
 * Record a failure and decide whether to retry.
 *
 * Exponential backoff, then a dead state that stays visible to admins rather
 * than disappearing — a silently dead queue is worse than a loud one.
 */
export async function failJob(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  await withoutTenantScope('worker', async (db) => {
    await db.execute(sql`
      UPDATE job_queue SET
        status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
        run_at = now() + (interval '30 seconds' * power(2, least(attempts, 6))),
        locked_by = NULL,
        last_error = ${message.slice(0, 1000)}
      WHERE id = ${jobId}
    `);
  });
}
