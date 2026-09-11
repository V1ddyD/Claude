import 'server-only';
import { claimJobs, completeJob, failJob, type Job } from './queue';
import { extractAndScore } from '@/server/ai/extraction';
import { releaseExpiredReservations } from '@/server/services/inventory';
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
  const jobs = await claimJobs(limit);
  let succeeded = 0;
  let failed = 0;

  for (const job of jobs) {
    const handler = HANDLERS[job.kind];
    if (!handler) {
      await failJob(job.id, new Error(`No handler for job kind "${job.kind}"`));
      failed++;
      continue;
    }
    try {
      await handler(job);
      await completeJob(job.id);
      succeeded++;
    } catch (error) {
      // One failing job must not stop the batch.
      await failJob(job.id, error);
      failed++;
    }
  }

  return { claimed: jobs.length, succeeded, failed };
}

export { enqueue } from './queue';
