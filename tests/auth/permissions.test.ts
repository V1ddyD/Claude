import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import {
  ROLE_PERMISSIONS, PERMISSIONS, roleHas, canManageRole, leadVisibility,
  effectivePermissions,
  type Permission,
} from '../../src/server/auth/permissions';
import type { StaffRole } from '../../src/server/db/schema';

let admin: Sql;
beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});
afterAll(async () => {
  await admin?.end({ timeout: 5 });
});

describe('the permission matrix in code and in the database', () => {
  it('agree exactly', async () => {
    const rows = await admin<{ role: StaffRole; permission: Permission }[]>`
      SELECT role, permission FROM role_permissions ORDER BY role, permission
    `;

    const fromDb = new Map<StaffRole, Set<string>>();
    for (const r of rows) {
      if (!fromDb.has(r.role)) fromDb.set(r.role, new Set());
      fromDb.get(r.role)!.add(r.permission);
    }

    // The database is authoritative; the TypeScript copy exists so guards are
    // typed. They are two representations of one fact, so they must not drift.
    for (const role of Object.keys(ROLE_PERMISSIONS) as StaffRole[]) {
      const inCode = [...ROLE_PERMISSIONS[role]].sort();
      const inDb = [...(fromDb.get(role) ?? [])].sort();
      expect(inDb, `role ${role} differs between code and database`).toEqual(inCode);
    }
  });

  it('uses only declared permissions', async () => {
    const rows = await admin<{ permission: string }[]>`
      SELECT DISTINCT permission FROM role_permissions
    `;
    const declared = new Set<string>(PERMISSIONS);
    const undeclared = rows.map((r) => r.permission).filter((p) => !declared.has(p));
    expect(undeclared).toEqual([]);
  });
});

describe('a broader grant satisfying a narrower guard', () => {
  /**
   * `lead.read.all` and `lead.read.assigned` are one capability at two widths.
   * A guard asking for the narrow one is asking "may you read leads at all",
   * and the answer for a manager is yes. This used to be false, and the
   * dashboard — the page every sign-in lands on — threw FORBIDDEN at every
   * manager and admin in the dealership.
   */
  it('lets a manager and an admin past a lead.read.assigned guard', () => {
    for (const role of ['manager', 'admin'] as StaffRole[]) {
      expect.soft(effectivePermissions(role).has('lead.read.assigned')).toBe(true);
    }
  });

  it('still lets sales past it on their own grant', () => {
    expect(effectivePermissions('sales').has('lead.read.assigned')).toBe(true);
  });

  it('grants nothing to a role that holds neither', () => {
    const service = effectivePermissions('service');
    expect(service.has('lead.read.assigned')).toBe(false);
    expect(service.has('lead.read.all')).toBe(false);
  });

  it('does not widen anything but lead reading', () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as StaffRole[]) {
      const extra = [...effectivePermissions(role)].filter(
        (p) => !ROLE_PERMISSIONS[role].includes(p),
      );
      expect.soft(extra, `role ${role} gained more than lead reading`).toEqual(
        role === 'manager' || role === 'admin' ? ['lead.read.assigned'] : [],
      );
    }
  });

  it('leaves the database mirror alone', () => {
    // `roleHas` is what the mirror test compares against the seed, so the
    // implication must live outside it or the two would appear to disagree.
    expect(roleHas('admin', 'lead.read.assigned')).toBe(false);
    expect(roleHas('manager', 'lead.read.assigned')).toBe(false);
  });
});

describe('least privilege', () => {
  it('denies sales the permissions that decide money and access', () => {
    for (const p of ['inventory.price.write', 'settings.write', 'audit.read',
                     'staff.manage', 'lead.assign', 'analytics.read'] as Permission[]) {
      expect.soft(roleHas('sales', p), `sales should not hold ${p}`).toBe(false);
    }
  });

  it('keeps sales and service tickets separate', () => {
    expect(roleHas('sales', 'ticket.service.write')).toBe(false);
    expect(roleHas('service', 'ticket.sales.write')).toBe(false);
  });

  it('denies service access to the sales pipeline', () => {
    expect(roleHas('service', 'lead.read.all')).toBe(false);
    expect(roleHas('service', 'lead.read.assigned')).toBe(false);
    expect(roleHas('service', 'conversation.read')).toBe(false);
  });

  it('reserves audit and settings for admins alone', () => {
    const roles: StaffRole[] = ['sales', 'service', 'manager', 'admin'];
    expect(roles.filter((r) => roleHas(r, 'audit.read'))).toEqual(['admin']);
    expect(roles.filter((r) => roleHas(r, 'settings.write'))).toEqual(['admin']);
    expect(roles.filter((r) => roleHas(r, 'inventory.price.write'))).toEqual(['admin']);
  });

  it('scopes lead visibility by role rather than by guard', () => {
    expect(leadVisibility('sales')).toBe('assigned');
    expect(leadVisibility('service')).toBe('assigned');
    expect(leadVisibility('manager')).toBe('all');
    expect(leadVisibility('admin')).toBe('all');
  });

  it('stops managers escalating another manager or an admin', () => {
    expect(canManageRole('manager', 'sales')).toBe(true);
    expect(canManageRole('manager', 'service')).toBe(true);
    expect(canManageRole('manager', 'manager')).toBe(false);
    expect(canManageRole('manager', 'admin')).toBe(false);
    expect(canManageRole('sales', 'sales')).toBe(false);
    expect(canManageRole('admin', 'admin')).toBe(true);
  });
});
