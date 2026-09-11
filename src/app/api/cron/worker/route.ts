import { NextResponse, type NextRequest } from 'next/server';
import { runWorker, enqueue } from '@/server/jobs';
import { listActiveTenantIds } from '@/server/db/control-plane';
import { withTenant } from '@/server/db/tenant-db';
import { env } from '@/server/config/env';

/**
 * Drains the job queue. Invoked by the platform's scheduler.
 *
 * Authenticated by a shared secret in a constant-time comparison — a public
 * endpoint that runs arbitrary queued work is a denial-of-service surface.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const secret = env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Worker is not configured.' }, { status: 503 });
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!timingSafeEqual(provided, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Recurring work is enqueued here rather than stored as scheduled rows: the
  // cron call IS the schedule, and a job that is due every tick does not need a
  // row waiting for it. Each handler is idempotent, so a double tick is safe.
  await scheduleRecurringWork();

  const report = await runWorker();
  return NextResponse.json(report);
}

async function scheduleRecurringWork(): Promise<void> {
  const tenantIds = await listActiveTenantIds();

  for (const tenantId of tenantIds) {
    await withTenant(tenantId, async (db) => {
      await enqueue(db, 'evaluate_follow_ups', {});
      await enqueue(db, 'expire_holds', {});
      await enqueue(db, 'send_email', {});
      await enqueue(db, 'apply_retention', {});
      await enqueue(db, 'sweep_rate_limits', {});
    });
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
