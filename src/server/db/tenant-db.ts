import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { unscopedDb } from '@/server/db/client';
import { env } from '@/server/config/env';
import { AppError } from '@/server/errors';

/**
 * Tenant-scoped database access.
 *
 * Every query touching tenant data runs inside a transaction that has set the
 * Postgres GUC `app.tenant_id`. That GUC is what the RLS policies in migration
 * 0002 read, so the isolation guarantee is:
 *
 *   no transaction context  ->  every tenant table returns zero rows
 *   wrong tenant context    ->  zero rows, and writes fail the WITH CHECK
 *
 * It fails closed. A forgotten `WHERE tenant_id = ...` yields an empty result,
 * never another dealership's customers.
 *
 * `TenantDb` is branded so a repository cannot be handed the unscoped handle by
 * mistake — the types simply do not line up.
 */

/**
 * Bring the schema up to date before the first query touches it.
 *
 * Written after a real outage: a build shipped code needing
 * `conversations.handed_off_at`, the column was never added to the live
 * database, and every chat turn then asked for something that did not exist.
 * Nothing in the deployment was wrong — the missing step was one a person had
 * to remember, and the deployment that needed it had nobody watching.
 *
 * Here rather than in `instrumentation.ts`, which would be the obvious home:
 * Next compiles that file for the edge runtime as well, and follows the
 * migrator's imports into a bundle that has no `node:fs` — a runtime guard
 * stops execution, not bundling. This module is server-only and middleware
 * imports nothing from it, so it never reaches that bundle.
 *
 * Costs one already-resolved promise per call after the first, and does
 * nothing at all on a deployment that has not opted in.
 */
async function ensureSchema(): Promise<void> {
  const { autoMigrate } = await import('./auto-migrate');
  await autoMigrate();
}

declare const tenantBrand: unique symbol;

type DrizzleTx = Parameters<Parameters<typeof unscopedDb.transaction>[0]>[0];

export type TenantDb = DrizzleTx & {
  readonly [tenantBrand]: 'tenant-scoped';
  readonly tenantId: string;
};

const uuid = z.string().uuid();

/**
 * Drop to the request role for the rest of the transaction.
 *
 * A no-op when the deployment connects as an unprivileged role already, which
 * is the case wherever two connection strings are configured. Where the
 * platform supplies one role that owns the tables, this is what stops the
 * request path running with the owner's privileges — RLS is FORCEd, so it would
 * still apply, but the table grants would not, and `audit_logs` being
 * append-only is a grant.
 *
 * `SET LOCAL` reverts at the end of the transaction, so nothing leaks between
 * pooled connections. The role name is validated as an identifier when the
 * environment is read; it is never taken from a request.
 */
async function assumeRequestRole(tx: DrizzleTx): Promise<void> {
  const role = env.DATABASE_REQUEST_ROLE;
  if (!role) return;
  await tx.execute(sql.raw(`SET LOCAL ROLE "${role}"`));
}

export interface TenantContext {
  tenantId: string;
  /** Authenticated staff member, if any. Read by RLS for the staff_users policy. */
  authUserId?: string;
}

/**
 * Run `fn` inside a transaction scoped to one tenant.
 *
 * The whole callback is a single transaction, which is deliberate: a booking
 * that creates an appointment, a ticket, an outbox row and audit entries either
 * commits entirely or leaves nothing behind (spec §33).
 */
export async function withTenant<T>(
  ctx: TenantContext | string,
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const { tenantId, authUserId } = typeof ctx === 'string' ? { tenantId: ctx, authUserId: undefined } : ctx;

  if (!uuid.safeParse(tenantId).success) {
    // Never interpolate an unvalidated value into a session setting.
    throw new AppError('TENANT_NOT_RESOLVED', 'Invalid tenant context.', {
      internal: { tenantId },
    });
  }
  if (authUserId !== undefined && !uuid.safeParse(authUserId).success) {
    throw new AppError('UNAUTHENTICATED', 'Invalid session.', { internal: { authUserId } });
  }

  await ensureSchema();

  return unscopedDb.transaction(async (tx) => {
    // Privilege first, before anything is read or written.
    await assumeRequestRole(tx);

    // set_config(..., is_local => true) is transaction-scoped, like SET LOCAL,
    // and unlike SET LOCAL it accepts a bound parameter rather than requiring
    // string interpolation into DDL-ish syntax.
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    if (authUserId) {
      await tx.execute(sql`select set_config('app.auth_user_id', ${authUserId}, true)`);
    }

    const scoped = Object.assign(tx, { tenantId }) as TenantDb;
    return fn(scoped);
  });
}

/**
 * Run `fn` with only an authenticated subject established — no tenant yet.
 *
 * This exists for exactly one step: looking up a staff member's own row during
 * sign-in, which is what DETERMINES their tenant. The `staff_self` RLS policy
 * scopes that read to the authenticated subject, so it can return one row —
 * the caller's own — and cannot be used to enumerate anyone else's staff.
 */
export async function withAuthSubject<T>(
  authUserId: string,
  fn: (db: DrizzleTx) => Promise<T>,
): Promise<T> {
  if (!uuid.safeParse(authUserId).success) {
    throw new AppError('UNAUTHENTICATED', 'Invalid session.', { internal: { authUserId } });
  }
  return unscopedDb.transaction(async (tx) => {
    await assumeRequestRole(tx);
    await tx.execute(sql`select set_config('app.auth_user_id', ${authUserId}, true)`);
    return fn(tx);
  });
}

/**
 * Escape hatch for the few operations that legitimately precede a tenant
 * context: hostname -> tenant resolution, sign-in's staff_users lookup, the job
 * worker iterating tenants, and migrations.
 *
 * Named to be conspicuous in review. Anything calling this from a request path
 * that already knows its tenant is a bug.
 */
export async function withoutTenantScope<T>(
  reason: 'tenant-resolution' | 'staff-signin' | 'worker' | 'migration' | 'health',
  fn: (db: typeof unscopedDb) => Promise<T>,
): Promise<T> {
  // 'migration' is how the migrator itself reaches the database. Waiting for
  // the schema here would be waiting for itself.
  if (reason !== 'migration') await ensureSchema();
  void reason;
  // Deliberately not privilege-dropped: these are control-plane operations
  // (resolving a hostname, claiming a job, sweeping counters) and several are
  // single statements rather than transactions, which is where SET LOCAL would
  // have to live. Where two connection strings are configured they already run
  // as the unprivileged role; under a single owner credential they run as the
  // owner, which is the one place that posture is looser than the design.
  return fn(unscopedDb);
}
