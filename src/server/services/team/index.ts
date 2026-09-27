import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { leads, staffUsers, tenants, type StaffRole } from '@/server/db/schema';
import type { TenantDb } from '@/server/db/tenant-db';
import type { StaffContext } from '@/server/auth/require-staff';
import { normaliseEmail, revokeSessions, setTemporaryPassword } from '@/server/auth/staff-auth';
import { temporaryPassword } from '@/server/auth/passwords';
import { recordAudit } from '@/server/services/audit';

/**
 * A business managing its own staff.
 *
 * Every rule is enforced here, on the server, whatever the page offered:
 *
 *   seats          Starter 3, Pro 10, Elite unlimited, counting everyone
 *                  who can sign in
 *   who manages    an owner manages everyone; a manager manages sales and
 *                  service staff, and cannot create, change or remove an owner
 *                  or another manager
 *   never locked   nobody removes or demotes themselves, and the last owner
 *                  cannot be removed or demoted: a business must always have
 *                  somebody who can manage it
 *   takes effect   removing somebody, or resetting their password, signs them
 *                  out everywhere at once
 */

export type Plan = 'starter' | 'pro' | 'elite';

export const PLAN_SEATS: Record<Plan, number> = { starter: 3, pro: 10, elite: Number.POSITIVE_INFINITY };

export const PLAN_LABEL: Record<Plan, string> = { starter: 'Starter', pro: 'Pro', elite: 'Elite' };

export const ROLES: StaffRole[] = ['admin', 'manager', 'sales', 'service'];

export interface TeamMember {
  id: string;
  fullName: string;
  email: string;
  role: StaffRole;
  lastSignIn: Date | null;
  isYou: boolean;
  /** Whether the person looking may change or remove this member. */
  manageable: boolean;
}

export interface Team {
  plan: Plan;
  seats: number;
  used: number;
  members: TeamMember[];
  /** Roles the person looking may give. */
  assignable: StaffRole[];
}

export type TeamResult =
  | { ok: true; message: string; temporaryPassword?: string; email?: string; removed?: boolean }
  | { ok: false; message: string };

/** The roles a person may hand out, and so may manage. */
function assignableBy(role: StaffRole): StaffRole[] {
  if (role === 'admin') return ROLES;
  if (role === 'manager') return ['sales', 'service'];
  return [];
}

async function planOf(db: TenantDb): Promise<Plan> {
  const [row] = await db.select({ plan: tenants.plan }).from(tenants).where(eq(tenants.id, db.tenantId)).limit(1);
  return (row?.plan ?? 'starter') as Plan;
}

async function seatsUsed(db: TenantDb): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staffUsers)
    .where(and(eq(staffUsers.tenantId, db.tenantId), inArray(staffUsers.status, ['active', 'invited'])));
  return Number(row?.n ?? 0);
}

export async function loadTeam(db: TenantDb, actor: StaffContext): Promise<Team> {
  const plan = await planOf(db);
  const rows = await db
    .select({
      id: staffUsers.id,
      fullName: staffUsers.fullName,
      email: staffUsers.email,
      role: staffUsers.role,
      // Written out in full: interpolated columns lose their table name inside
      // a subquery, and staff_sessions.id = staff_sessions.staff_id is never true.
      lastSignIn: sql<Date | null>`(
        SELECT max(ss.created_at) FROM staff_sessions ss
        WHERE ss.tenant_id = staff_users.tenant_id AND ss.staff_id = staff_users.id
      )`,
    })
    .from(staffUsers)
    .where(and(eq(staffUsers.tenantId, db.tenantId), eq(staffUsers.status, 'active')))
    .orderBy(staffUsers.fullName)
    .limit(500);

  const assignable = assignableBy(actor.role);
  return {
    plan,
    seats: PLAN_SEATS[plan],
    used: await seatsUsed(db),
    assignable,
    members: rows.map((row) => ({
      ...row,
      role: row.role as StaffRole,
      lastSignIn: row.lastSignIn ? new Date(row.lastSignIn) : null,
      isYou: row.id === actor.authUserId,
      manageable: row.id !== actor.authUserId && assignable.includes(row.role as StaffRole),
    })),
  };
}

const newMember = z.object({
  fullName: z.string().trim().min(1, 'Enter their name.').max(80, 'That name is too long.'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  role: z.enum(['admin', 'manager', 'sales', 'service']),
});

export async function addMember(
  db: TenantDb,
  actor: StaffContext,
  input: { fullName: string; email: string; role: string },
): Promise<TeamResult> {
  const parsed = newMember.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the details.' };
  const { fullName, role } = parsed.data;
  const email = normaliseEmail(parsed.data.email);

  if (!assignableBy(actor.role).includes(role)) {
    return { ok: false, message: "You can't add someone with that role." };
  }

  const plan = await planOf(db);
  if ((await seatsUsed(db)) >= PLAN_SEATS[plan]) {
    return {
      ok: false,
      message: `Your ${PLAN_LABEL[plan]} package includes ${PLAN_SEATS[plan]} staff accounts, and they're all in use. Remove someone, or ask us about upgrading.`,
    };
  }

  const [existing] = await db
    .select({ id: staffUsers.id, status: staffUsers.status })
    .from(staffUsers)
    .where(and(eq(staffUsers.tenantId, db.tenantId), eq(staffUsers.email, email)))
    .limit(1);
  if (existing && existing.status !== 'suspended') {
    return { ok: false, message: 'Someone with that email is already on your team.' };
  }

  // A person who was removed and is coming back keeps their history.
  const id = existing?.id ?? randomUUID();
  if (existing) {
    await db
      .update(staffUsers)
      .set({ fullName, role, status: 'active' })
      .where(and(eq(staffUsers.tenantId, db.tenantId), eq(staffUsers.id, id)));
  } else {
    await db.insert(staffUsers).values({ id, tenantId: db.tenantId, email, fullName, role, status: 'active' });
  }

  const password = temporaryPassword();
  await setTemporaryPassword(db, id, email, password);
  await recordAudit(db, {
    actor: { type: 'staff', id: actor.authUserId },
    action: existing ? 'staff.restored' : 'staff.added',
    entityType: 'staff_user',
    entityId: id,
    after: { role },
  });

  return {
    ok: true,
    message: `${fullName} has been added. Give them this temporary password; they'll choose their own when they first sign in.`,
    temporaryPassword: password,
    email,
  };
}

async function target(db: TenantDb, staffId: string) {
  if (!z.string().uuid().safeParse(staffId).success) return null;
  const [row] = await db
    .select({ id: staffUsers.id, fullName: staffUsers.fullName, email: staffUsers.email, role: staffUsers.role })
    .from(staffUsers)
    .where(and(eq(staffUsers.tenantId, db.tenantId), eq(staffUsers.id, staffId), eq(staffUsers.status, 'active')))
    .limit(1);
  return row ? { ...row, role: row.role as StaffRole } : null;
}

async function otherOwners(db: TenantDb, excluding: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staffUsers)
    .where(
      and(
        eq(staffUsers.tenantId, db.tenantId),
        eq(staffUsers.role, 'admin'),
        eq(staffUsers.status, 'active'),
        ne(staffUsers.id, excluding),
      ),
    );
  return Number(row?.n ?? 0);
}

/** The shared checks before changing someone else's account. */
async function mayManage(db: TenantDb, actor: StaffContext, staffId: string) {
  const member = await target(db, staffId);
  if (!member) return { error: 'That person is no longer on your team.' } as const;
  if (member.id === actor.authUserId) return { error: "You can't do that to your own account here." } as const;
  if (!assignableBy(actor.role).includes(member.role)) {
    return { error: "You don't have permission to change that person's account." } as const;
  }
  return { member } as const;
}

export async function removeMember(db: TenantDb, actor: StaffContext, staffId: string): Promise<TeamResult> {
  const check = await mayManage(db, actor, staffId);
  if ('error' in check) return { ok: false, message: check.error ?? 'Not allowed.' };
  const { member } = check;
  if (member.role === 'admin' && (await otherOwners(db, member.id)) === 0) {
    return { ok: false, message: 'Your business needs at least one owner. Make someone else an owner first.' };
  }

  await db
    .update(staffUsers)
    .set({ status: 'suspended' })
    .where(and(eq(staffUsers.tenantId, db.tenantId), eq(staffUsers.id, member.id)));
  await revokeSessions(db, member.id);
  // Their open leads go back to the unassigned pile, where someone will see them.
  await db
    .update(leads)
    .set({ assignedStaffId: null })
    .where(and(eq(leads.tenantId, db.tenantId), eq(leads.assignedStaffId, member.id)));
  await recordAudit(db, {
    actor: { type: 'staff', id: actor.authUserId },
    action: 'staff.removed',
    entityType: 'staff_user',
    entityId: member.id,
    before: { role: member.role },
  });
  return { ok: true, message: `${member.fullName} has been removed and signed out everywhere.`, removed: true };
}

export async function resetMemberPassword(db: TenantDb, actor: StaffContext, staffId: string): Promise<TeamResult> {
  const check = await mayManage(db, actor, staffId);
  if ('error' in check) return { ok: false, message: check.error ?? 'Not allowed.' };
  const { member } = check;

  const password = temporaryPassword();
  await setTemporaryPassword(db, member.id, member.email, password);
  await recordAudit(db, {
    actor: { type: 'staff', id: actor.authUserId },
    action: 'staff.password_reset',
    entityType: 'staff_user',
    entityId: member.id,
  });
  return {
    ok: true,
    message: `${member.fullName}'s password has been reset and they've been signed out. Give them this temporary password:`,
    temporaryPassword: password,
    email: member.email,
  };
}

export async function changeMemberRole(
  db: TenantDb,
  actor: StaffContext,
  staffId: string,
  role: string,
): Promise<TeamResult> {
  const parsedRole = z.enum(['admin', 'manager', 'sales', 'service']).safeParse(role);
  if (!parsedRole.success) return { ok: false, message: 'Choose a role.' };
  const check = await mayManage(db, actor, staffId);
  if ('error' in check) return { ok: false, message: check.error ?? 'Not allowed.' };
  const { member } = check;
  if (!assignableBy(actor.role).includes(parsedRole.data)) {
    return { ok: false, message: "You can't give that role." };
  }
  if (member.role === 'admin' && parsedRole.data !== 'admin' && (await otherOwners(db, member.id)) === 0) {
    return { ok: false, message: 'Your business needs at least one owner.' };
  }
  if (member.role === parsedRole.data) return { ok: true, message: 'No change.' };

  await db
    .update(staffUsers)
    .set({ role: parsedRole.data })
    .where(and(eq(staffUsers.tenantId, db.tenantId), eq(staffUsers.id, member.id)));
  await recordAudit(db, {
    actor: { type: 'staff', id: actor.authUserId },
    action: 'staff.role_changed',
    entityType: 'staff_user',
    entityId: member.id,
    before: { role: member.role },
    after: { role: parsedRole.data },
  });
  return { ok: true, message: `${member.fullName} is now ${ROLE_NAMES[parsedRole.data]}.` };
}

export const ROLE_NAMES: Record<StaffRole, string> = {
  admin: 'an owner',
  manager: 'a manager',
  sales: 'sales staff',
  service: 'service staff',
};

