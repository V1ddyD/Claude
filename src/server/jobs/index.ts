import 'server-only';
import { claimJobs, completeJob, failJob, type Job } from './queue';
import { listActiveTenantIds } from '@/server/db/control-plane';
import { extractAndScore } from '@/server/ai/extraction';
import { releaseExpiredReservations } from '@/server/services/inventory';
import { drainOutbox } from '@/server/services/email/outbox';
import { evaluateFollowUps } from '@/server/services/follow-ups';
import { applyRetention } from '@/server/services/retention';
import { sweepRateLimits } from '@/server/services/limits';
import { withTenant } from '@/server/db/tenant-db';

/** Job handlers. Each must be idempotent: a retry re-runs the whole handler. */
const HANDLERS: Record<string, (job: Job) => Promise<void>> = {
  extract_and_score: async (job) => {
    if (!job.tenantId) return;
    await extractAndScore({
      tenantId: job.tenantId,
      conversationId: String(job.payload.conversationId),
    });
  },

  send_email: async (job) => {
    // The queue row is a trigger; the outbox is the source of truth, so this
    // drains whatever is due for the tenant rather than one named message.
    if (!job.tenantId) return;
    await drainOutbox(job.tenantId);
  },

  evaluate_follow_ups: async (job) => {
    if (!job.tenantId) return;
    await evaluateFollowUps(job.tenantId);
  },

  apply_retention: async (job) => {
    if (!job.tenantId) return;
    await applyRetention(job.tenantId);
  },

  sweep_rate_limits: async () => {
    await sweepRateLimits();
  },

  expire_holds: async (job) => {
    if (!job.tenantId) return;
    await withTenant(job.tenantId, (db) => releaseExpiredReservations(db));
  },
};

export interface WorkerReport {
  claimed: number;
  succeeded: number;
  failed: number;
}

export async function runWorker(limit = 10): Promise<WorkerReport> {
  // Tenants are enumerated through the control plane; every job then runs in
  // its own tenant context, under RLS, as the application role.
  const tenantIds = await listActiveTenantIds();

  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    const jobs = await claimJobs(tenantId, limit);
    claimed += jobs.length;

    for (const job of jobs) {
      const handler = HANDLERS[job.kind];
      if (!handler) {
        await failJob(tenantId, job.id, new Error(`No handler for job kind "${job.kind}"`));
        failed++;
        continue;
      }
      try {
        await handler(job);
        await completeJob(tenantId, job.id);
        succeeded++;
      } catch (error) {
        // One failing job must not stop the batch, or one tenant's problem
        // becomes every tenant's outage.
        await failJob(tenantId, job.id, error);
        failed++;
      }
    }
  }

  return { claimed, succeeded, failed };
}

export { enqueue } from './queue';
