import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID, NORTHWIND_TENANT_ID } from '../../db/seeds/sinclair';
import { closeConnections } from '../../src/server/db/client';
import { withTenant } from '../../src/server/db/tenant-db';
import { enqueue } from '../../src/server/jobs';
import { runWorker } from '../../src/server/jobs';
import { listActiveTenantIds } from '../../src/server/db/control-plane';

/**
 * The background worker.
 *
 * This suite exists because the worker was written to claim jobs across every
 * tenant at once, which RLS silently refused — it claimed nothing, reported
 * success, and no test noticed. Anything that runs outside a request needs its
 * own coverage precisely because nobody watches it fail.
 */

let admin: Sql;

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

describe('the control plane', () => {
  it('can enumerate tenants, which the request path cannot', async () => {
    const ids = await listActiveTenantIds();
    expect(ids).toContain(SINCLAIR_TENANT_ID);
    expect(ids).toContain(NORTHWIND_TENANT_ID);
  });
});

describe('claiming work', () => {
  it('actually claims and completes a job', async () => {
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      enqueue(db, 'expire_holds', { probe: 'worker-test' }),
    );

    const report = await runWorker();
    expect(report.claimed).toBeGreaterThan(0);
    expect(report.succeeded).toBeGreaterThan(0);

    const [row] = await admin<{ status: string }[]>`
      SELECT status FROM job_queue
      WHERE payload->>'probe' = 'worker-test' ORDER BY created_at DESC LIMIT 1
    `;
    expect(row?.status).toBe('done');
  });

  it('works across more than one tenant', async () => {
    await withTenant(SINCLAIR_TENANT_ID, (db) => enqueue(db, 'expire_holds', { t: 'a' }));
    await withTenant(NORTHWIND_TENANT_ID, (db) => enqueue(db, 'expire_holds', { t: 'b' }));

    await runWorker();

    const rows = await admin<{ tenant_id: string; status: string }[]>`
      SELECT tenant_id, status FROM job_queue WHERE payload->>'t' IN ('a','b')
    `;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'done')).toBe(true);
  });

  it('retries a failing job with backoff rather than losing it', async () => {
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      // No handler exists for this kind, so the job fails deterministically.
      enqueue(db, 'no_such_kind' as 'expire_holds', { probe: 'unhandled' }),
    );

    const report = await runWorker();
    expect(report.failed).toBeGreaterThan(0);

    const [row] = await admin<{ status: string; attempts: number; last_error: string; run_at: Date }[]>`
      SELECT status, attempts, last_error, run_at FROM job_queue
      WHERE payload->>'probe' = 'unhandled' ORDER BY created_at DESC LIMIT 1
    `;
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain('No handler');
    expect(row!.run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('gives up after the attempt limit instead of retrying forever', async () => {
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      enqueue(db, 'no_such_kind' as 'expire_holds', { probe: 'dead' }),
    );
    // Exhaust the attempts, making each retry immediately due.
    for (let i = 0; i < 6; i++) {
      await admin`
        UPDATE job_queue SET run_at = now()
        WHERE payload->>'probe' = 'dead' AND status = 'pending'
      `;
      await runWorker();
    }

    const [row] = await admin<{ status: string; attempts: number }[]>`
      SELECT status, attempts FROM job_queue WHERE payload->>'probe' = 'dead'
    `;
    // Dead, not pending: a job that can never succeed must stop consuming the
    // queue, and must stay visible to an admin rather than vanishing.
    expect(row?.status).toBe('dead');
    expect(row!.attempts).toBeGreaterThanOrEqual(5);
  });

  it('does not claim a job scheduled for the future', async () => {
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      enqueue(db, 'expire_holds', { probe: 'later' }, { runAt: new Date(Date.now() + 3600_000) }),
    );

    await runWorker();

    const [row] = await admin<{ status: string }[]>`
      SELECT status FROM job_queue WHERE payload->>'probe' = 'later'
    `;
    expect(row?.status).toBe('pending');
  });
});
