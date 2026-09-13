import type { StaffRole } from '@/server/db/schema';

/**
 * The permission vocabulary. `entity.action.scope`.
 *
 * Kept as a literal union rather than plain strings so a typo in a guard is a
 * compile error rather than a silently-denied (or silently-allowed) route.
 */
export const PERMISSIONS = [
  'lead.read.assigned',
  'lead.read.all',
  'lead.assign',
  'lead.status.write',
  'lead.note.write',
  'customer.read',
  'customer.pii.export',
  'appointment.read',
  'appointment.write',
  'ticket.sales.read',
  'ticket.sales.write',
  'ticket.service.read',
  'ticket.service.write',
  'inventory.read',
  'inventory.status.write',
  'inventory.price.write',
  'catalogue.read',
  'catalogue.write',
  'conversation.read',
  'analytics.read',
  'staff.manage',
  'settings.write',
  'audit.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Mirrors the seed in migration 0002. Duplicated deliberately: the database is
 * authoritative, and `tests/auth/permissions.test.ts` asserts the two agree, so
 * a change to one that is not made to the other fails CI rather than producing
 * a permission that behaves differently in code than in the database.
 */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  sales: [
    'lead.read.assigned', 'lead.status.write', 'lead.note.write',
    'customer.read', 'appointment.read', 'appointment.write',
    'ticket.sales.read', 'ticket.sales.write',
    'inventory.read', 'catalogue.read', 'conversation.read',
  ],
  service: [
    'customer.read', 'appointment.read', 'appointment.write',
    'ticket.service.read', 'ticket.service.write',
    'inventory.read', 'catalogue.read',
  ],
  manager: [
    'lead.read.all', 'lead.assign', 'lead.status.write', 'lead.note.write',
    'customer.read', 'customer.pii.export',
    'appointment.read', 'appointment.write',
    'ticket.sales.read', 'ticket.sales.write',
    'ticket.service.read', 'ticket.service.write',
    'inventory.read', 'inventory.status.write',
    'catalogue.read', 'conversation.read', 'analytics.read', 'staff.manage',
  ],
  admin: [
    'lead.read.all', 'lead.assign', 'lead.status.write', 'lead.note.write',
    'customer.read', 'customer.pii.export',
    'appointment.read', 'appointment.write',
    'ticket.sales.read', 'ticket.sales.write',
    'ticket.service.read', 'ticket.service.write',
    'inventory.read', 'inventory.status.write', 'inventory.price.write',
    'catalogue.read', 'catalogue.write', 'conversation.read',
    'analytics.read', 'staff.manage', 'settings.write', 'audit.read',
  ],
};

/**
 * Grants that already contain a narrower one.
 *
 * `lead.read.all` and `lead.read.assigned` are the same capability at two
 * widths: one sees every lead, the other only its own. A guard asking for the
 * narrow one is asking "may you read leads at all", and a manager who may read
 * ALL of them plainly may — but the matrix lists the two side by side, so
 * holding the broader grant did not satisfy the narrower guard and the
 * dashboard threw FORBIDDEN at every manager and admin.
 *
 * The implication belongs here, once, rather than as a special case at each
 * place that asks. It only ever widens what a role can do, never narrows it,
 * and it is deliberately not folded into `ROLE_PERMISSIONS` — that stays a
 * literal mirror of what migration 0002 seeds.
 */
const IMPLIES: Partial<Record<Permission, readonly Permission[]>> = {
  'lead.read.all': ['lead.read.assigned'],
};

/** Everything a role may do, including what its grants imply. */
export function effectivePermissions(role: StaffRole): Set<Permission> {
  const granted = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const held of ROLE_PERMISSIONS[role]) {
    for (const implied of IMPLIES[held] ?? []) granted.add(implied);
  }
  return granted;
}

/**
 * Whether the matrix lists this permission against this role.
 *
 * Literal, so it stays comparable with the database seed — use
 * `effectivePermissions` to decide whether someone may actually do something.
 */
export function roleHas(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Whether a role may see every lead or only its own.
 *
 * Row-level scoping is separate from the permission grant: SALES holds
 * `lead.read.assigned`, which is a narrower version of the same capability, and
 * the repository applies the filter rather than the guard.
 */
export function leadVisibility(role: StaffRole): 'all' | 'assigned' {
  return roleHas(role, 'lead.read.all') ? 'all' : 'assigned';
}

/** Managers may manage SALES and SERVICE only; admins may manage anyone. */
export function canManageRole(actor: StaffRole, target: StaffRole): boolean {
  if (actor === 'admin') return true;
  if (actor === 'manager') return target === 'sales' || target === 'service';
  return false;
}
