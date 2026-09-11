import 'server-only';
import { eq } from 'drizzle-orm';
import { staffUsers, type StaffRole } from '@/server/db/schema';
import { withAuthSubject, withTenant, type TenantDb } from '@/server/db/tenant-db';
import { getAuthSubject } from '@/server/auth/session';
import { ROLE_PERMISSIONS, type Permission } from '@/server/auth/permissions';
import { forbidden, unauthenticated } from '@/server/errors';

/**
 * The authorization boundary.
 *
 * Every portal route handler, server action and loader calls this. Middleware
 * redirects unauthenticated browsers for a good user experience, but it is NOT
 * the boundary — a route that relies on middleware alone is exploitable by any
 * request that reaches it directly, and `tests/auth/portal-routes.test.ts`
 * enumerates the route tree to assert none does.
 *
 * Note what this returns: a tenant id read from the database, not from the
 * request. A staff member cannot operate on another dealership because there is
 * no input through which to name one.
 */

export interface StaffContext {
  authUserId: string;
  tenantId: string;
  role: StaffRole;
  fullName: string;
  email: string;
  can(permission: Permission): boolean;
  /** Throws FORBIDDEN unless the role holds the permission. */
  assert(permission: Permission): void;
}

export async function requireStaff(permission?: Permission): Promise<StaffContext> {
  const subject = await getAuthSubject();
  if (!subject) throw unauthenticated();

  const rows = await withAuthSubject(subject.authUserId, (db) =>
    db
      .select({
        id: staffUsers.id,
        tenantId: staffUsers.tenantId,
        role: staffUsers.role,
        fullName: staffUsers.fullName,
        email: staffUsers.email,
        status: staffUsers.status,
      })
      .from(staffUsers)
      .where(eq(staffUsers.id, subject.authUserId))
      .limit(1),
  );

  const staff = rows[0];

  // A valid auth session with no staff_users row is a CUSTOMER, or a
  // deactivated employee. Customers and staff share one auth pool, and this is
  // the only thing separating them.
  if (!staff || staff.status !== 'active') {
    throw forbidden({ authUserId: subject.authUserId, reason: !staff ? 'no-staff-row' : staff.status });
  }

  const granted = new Set<Permission>(ROLE_PERMISSIONS[staff.role]);
  const ctx: StaffContext = {
    authUserId: staff.id,
    tenantId: staff.tenantId,
    role: staff.role,
    fullName: staff.fullName,
    email: staff.email,
    can: (p) => granted.has(p),
    assert: (p) => {
      if (!granted.has(p)) throw forbidden({ role: staff.role, needed: p });
    },
  };

  if (permission) ctx.assert(permission);
  return ctx;
}

/**
 * The normal way a portal feature reads or writes: authorize, then open a
 * transaction already scoped to the staff member's own tenant.
 */
export async function withStaff<T>(
  permission: Permission,
  fn: (db: TenantDb, staff: StaffContext) => Promise<T>,
): Promise<T> {
  const staff = await requireStaff(permission);
  return withTenant({ tenantId: staff.tenantId, authUserId: staff.authUserId }, (db) =>
    fn(db, staff),
  );
}
