import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { unscopedDb } from '@/server/db/client';
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

declare const tenantBrand: unique symbol;

type DrizzleTx = Parameters<Parameters<typeof unscopedDb.transaction>[0]>[0];

export type TenantDb = DrizzleTx & {
  readonly [tenantBrand]: 'tenant-scoped';
  readonly tenantId: string;
};

const uuid = z.string().uuid();

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

  return unscopedDb.transaction(async (tx) => {
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
  void reason;
  return fn(unscopedDb);
}
