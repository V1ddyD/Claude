import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Sql } from 'postgres';
import { prepareDatabase, adminConnection } from '../helpers/db';
import { SINCLAIR_TENANT_ID, SINCLAIR_STAFF } from '../../db/seeds/sinclair';
import { withTenant } from '../../src/server/db/tenant-db';
import { closeConnections } from '../../src/server/db/client';
import { transitionStatus, releaseExpiredReservations } from '../../src/server/services/inventory';
import { ROLE_PERMISSIONS, type Permission } from '../../src/server/auth/permissions';
import type { StaffContext } from '../../src/server/auth/require-staff';
import { isAppError } from '../../src/server/errors';
import type { StaffRole } from '../../src/server/db/schema';

/**
 * The inventory state machine, against the real database.
 *
 * Transitions are rows, not code, so these assertions are really about whether
 * the table and the guard agree — which is the thing that would silently drift.
 */

let admin: Sql;

function staffContext(role: StaffRole, id: string): StaffContext {
  const granted = new Set<Permission>(ROLE_PERMISSIONS[role]);
  return {
    authUserId: id,
    tenantId: SINCLAIR_TENANT_ID,
    role,
    fullName: 'Test Staff',
    email: 'test@sinclair.test',
    can: (p) => granted.has(p),
    assert: (p) => {
      if (!granted.has(p)) throw new Error(`missing ${p}`);
    },
  };
}

const manager = () => staffContext('manager', SINCLAIR_STAFF.manager.id);
const sales = () => staffContext('sales', SINCLAIR_STAFF.sales.id);

/** A fresh available unit per test, so one test cannot depend on another. */
async function freshUnit(): Promise<{ id: string; version: number }> {
  const [config] = await admin<{ id: string; price: string }[]>`
    SELECT id, price_cents AS price FROM model_configurations
    WHERE tenant_id = ${SINCLAIR_TENANT_ID} LIMIT 1
  `;
  const stock = `TEST-${Math.random().toString(36).slice(2, 10)}`;
  const [unit] = await admin<{ id: string; version: number }[]>`
    INSERT INTO inventory_units (
      tenant_id, model_configuration_id, stock_number, status, asking_price_cents
    ) VALUES (
      ${SINCLAIR_TENANT_ID}, ${config!.id}, ${stock}, 'available', ${Number(config!.price)}
    )
    RETURNING id, version
  `;
  return unit!;
}

beforeAll(async () => {
  await prepareDatabase();
  admin = adminConnection();
});

afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await closeConnections();
});

describe('transitions', () => {
  it('allows available -> reserved -> sold', async () => {
    const unit = await freshUnit();

    const reserved = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      transitionStatus(db, manager(), {
        unitId: unit.id,
        toStatus: 'reserved',
        expectedVersion: unit.version,
        reservedUntil: new Date(Date.now() + 3 * 864e5),
      }),
    );
    expect(reserved.status).toBe('reserved');

    const sold = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      transitionStatus(db, manager(), {
        unitId: unit.id,
        toStatus: 'sold',
        expectedVersion: reserved.version,
      }),
    );
    expect(sold.status).toBe('sold');
  });

  it('refuses available -> sold, because no row permits it', async () => {
    const unit = await freshUnit();
    try {
      await withTenant(SINCLAIR_TENANT_ID, (db) =>
        transitionStatus(db, manager(), {
          unitId: unit.id,
          toStatus: 'sold',
          expectedVersion: unit.version,
        }),
      );
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toContain('cannot be moved to sold');
    }
  });

  it('refuses a sold car being moved back to available', async () => {
    const unit = await freshUnit();
    const reserved = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      transitionStatus(db, manager(), {
        unitId: unit.id, toStatus: 'reserved', expectedVersion: unit.version,
        reservedUntil: new Date(Date.now() + 864e5),
      }),
    );
    const sold = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      transitionStatus(db, manager(), {
        unitId: unit.id, toStatus: 'sold', expectedVersion: reserved.version,
      }),
    );
    await expect(
      withTenant(SINCLAIR_TENANT_ID, (db) =>
        transitionStatus(db, manager(), {
          unitId: unit.id, toStatus: 'available', expectedVersion: sold.version,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('requires an expiry when reserving', async () => {
    const unit = await freshUnit();
    await expect(
      withTenant(SINCLAIR_TENANT_ID, (db) =>
        transitionStatus(db, manager(), {
          unitId: unit.id, toStatus: 'reserved', expectedVersion: unit.version,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('is idempotent when the car is already in the target state', async () => {
    const unit = await freshUnit();
    const result = await withTenant(SINCLAIR_TENANT_ID, (db) =>
      transitionStatus(db, manager(), {
        unitId: unit.id, toStatus: 'available', expectedVersion: unit.version,
      }),
    );
    // A retried request must not fail after the first already succeeded.
    expect(result).toEqual({ status: 'available', version: unit.version });
  });
});

describe('authorization', () => {
  it('refuses a salesperson, who does not hold inventory.status.write', async () => {
    const unit = await freshUnit();
    try {
      await withTenant(SINCLAIR_TENANT_ID, (db) =>
        transitionStatus(db, sales(), {
          unitId: unit.id, toStatus: 'reserved', expectedVersion: unit.version,
          reservedUntil: new Date(Date.now() + 864e5),
        }),
      );
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.code).toBe('FORBIDDEN');
    }

    const [after] = await admin<{ status: string }[]>`
      SELECT status FROM inventory_units WHERE id = ${unit.id}
    `;
    expect(after?.status).toBe('available');
  });
});

describe('concurrency', () => {
  it('rejects a write based on a stale read', async () => {
    const unit = await freshUnit();

    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      transitionStatus(db, manager(), {
        unitId: unit.id, toStatus: 'service_hold', expectedVersion: unit.version,
      }),
    );

    // A second staff member acts on what they read before that change. The
    // transition itself is legal (service_hold -> available), so this reaches
    // the version check rather than being stopped by the state machine first.
    try {
      await withTenant(SINCLAIR_TENANT_ID, (db) =>
        transitionStatus(db, manager(), {
          unitId: unit.id, toStatus: 'available', expectedVersion: unit.version,
        }),
      );
      expect.unreachable('should have refused the stale write');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toContain('updated by someone else');
    }
  });

  it('reports the current state when a stale read also implies an illegal move', async () => {
    const unit = await freshUnit();
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      transitionStatus(db, manager(), {
        unitId: unit.id, toStatus: 'service_hold', expectedVersion: unit.version,
      }),
    );

    // The state machine is checked before the version, so the caller is told
    // what the car actually is rather than the less useful "someone else
    // changed it". Both are CONFLICT; this one is more actionable.
    try {
      await withTenant(SINCLAIR_TENANT_ID, (db) =>
        transitionStatus(db, manager(), {
          unitId: unit.id, toStatus: 'reserved', expectedVersion: unit.version,
          reservedUntil: new Date(Date.now() + 864e5),
        }),
      );
      expect.unreachable('should have refused');
    } catch (err) {
      if (!isAppError(err)) throw err;
      expect(err.code).toBe('CONFLICT');
      expect(err.message).toContain('on service hold');
      expect(err.data).toMatchObject({ from: 'service_hold', to: 'reserved' });
    }
  });
});

describe('audit', () => {
  it('records every move with before and after', async () => {
    const unit = await freshUnit();
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      transitionStatus(db, manager(), {
        unitId: unit.id, toStatus: 'reserved', expectedVersion: unit.version,
        reservedUntil: new Date(Date.now() + 864e5), reason: 'deposit taken',
      }),
    );

    const [entry] = await admin<{ action: string; before: unknown; after: unknown }[]>`
      SELECT action, before, after FROM audit_logs
      WHERE entity_id = ${unit.id} ORDER BY id DESC LIMIT 1
    `;
    expect(entry?.action).toBe('inventory.reserved');
    expect(entry?.before).toMatchObject({ status: 'available' });
    expect(entry?.after).toMatchObject({ status: 'reserved', reason: 'deposit taken' });
  });
});

describe('expiring reservations', () => {
  it('returns lapsed holds to the market and audits the release', async () => {
    const unit = await freshUnit();
    await withTenant(SINCLAIR_TENANT_ID, (db) =>
      transitionStatus(db, manager(), {
        unitId: unit.id, toStatus: 'reserved', expectedVersion: unit.version,
        reservedUntil: new Date(Date.now() + 864e5),
      }),
    );
    // Backdate the hold rather than waiting for it.
    await admin`UPDATE inventory_units SET reserved_until = now() - interval '1 hour' WHERE id = ${unit.id}`;

    const released = await withTenant(SINCLAIR_TENANT_ID, (db) => releaseExpiredReservations(db));
    expect(released).toBeGreaterThanOrEqual(1);

    const [after] = await admin<{ status: string; reserved_until: Date | null }[]>`
      SELECT status, reserved_until FROM inventory_units WHERE id = ${unit.id}
    `;
    expect(after?.status).toBe('available');
    expect(after?.reserved_until).toBeNull();

    const [entry] = await admin<{ action: string }[]>`
      SELECT action FROM audit_logs WHERE entity_id = ${unit.id} ORDER BY id DESC LIMIT 1
    `;
    expect(entry?.action).toBe('inventory.reservation_expired');
  });
});
