import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { inventoryUnits, inventoryTransitions, type InventoryStatus } from '@/server/db/schema';
import type { TenantDb } from '@/server/db/tenant-db';
import type { StaffContext } from '@/server/auth/require-staff';
import type { Permission } from '@/server/auth/permissions';
import { recordAudit } from '@/server/services/audit';
import { AppError, conflict, forbidden, notFound } from '@/server/errors';

/**
 * Inventory state.
 *
 * Transitions live in a table, not in a switch: `available -> sold` without
 * passing through `reserved` is refused because no row permits it, and a
 * dealership can be given a different lifecycle without a code change.
 *
 * The AI has no tool that reaches this module. Only a staff member holding
 * `inventory.status.write` can move a car (spec §17), and every move is audited.
 */

export interface TransitionRequest {
  unitId: string;
  toStatus: InventoryStatus;
  /** The version the caller last read. Rejects a write over someone else's. */
  expectedVersion: number;
  reservedUntil?: Date;
  reservedForCustomerId?: string;
  reason?: string;
}

export async function transitionStatus(
  db: TenantDb,
  staff: StaffContext,
  request: TransitionRequest,
): Promise<{ status: InventoryStatus; version: number }> {
  const rows = await db
    .select({
      id: inventoryUnits.id,
      status: inventoryUnits.status,
      version: inventoryUnits.version,
      stockNumber: inventoryUnits.stockNumber,
    })
    .from(inventoryUnits)
    .where(and(eq(inventoryUnits.tenantId, db.tenantId), eq(inventoryUnits.id, request.unitId)))
    .limit(1);

  const unit = rows[0];
  if (!unit) throw notFound('That vehicle');

  if (unit.status === request.toStatus) {
    // Idempotent: re-sending the same transition is not an error, so a retried
    // request does not fail after the first one already succeeded.
    return { status: unit.status, version: unit.version };
  }

  const allowed = await db
    .select({ requiredPermission: inventoryTransitions.requiredPermission })
    .from(inventoryTransitions)
    .where(
      and(
        eq(inventoryTransitions.fromStatus, unit.status),
        eq(inventoryTransitions.toStatus, request.toStatus),
      ),
    )
    .limit(1);

  const transition = allowed[0];
  if (!transition) {
    throw new AppError(
      'CONFLICT',
      `A vehicle that is ${label(unit.status)} cannot be moved to ${label(request.toStatus)}.`,
      { data: { from: unit.status, to: request.toStatus } },
    );
  }

  if (!staff.can(transition.requiredPermission as Permission)) {
    throw forbidden({ needed: transition.requiredPermission, role: staff.role });
  }

  if (request.toStatus === 'reserved' && !request.reservedUntil) {
    // The schema requires it, but failing here names the actual problem.
    throw new AppError('VALIDATION_FAILED', 'A reservation needs an expiry date.');
  }

  const updated = await db
    .update(inventoryUnits)
    .set({
      status: request.toStatus,
      reservedUntil: request.toStatus === 'reserved' ? (request.reservedUntil ?? null) : null,
      reservedForCustomerId:
        request.toStatus === 'reserved' ? (request.reservedForCustomerId ?? null) : null,
      version: sql`${inventoryUnits.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inventoryUnits.tenantId, db.tenantId),
        eq(inventoryUnits.id, request.unitId),
        // Optimistic concurrency: if someone else moved this car since the
        // caller read it, this matches nothing and we report the conflict
        // rather than overwriting their decision.
        eq(inventoryUnits.version, request.expectedVersion),
      ),
    )
    .returning({ status: inventoryUnits.status, version: inventoryUnits.version });

  const result = updated[0];
  if (!result) {
    throw conflict('That vehicle was updated by someone else. Reload and try again.', {
      stockNumber: unit.stockNumber,
    });
  }

  await recordAudit(db, {
    actor: { type: 'staff', id: staff.authUserId },
    action: `inventory.${request.toStatus}`,
    entityType: 'inventory_unit',
    entityId: request.unitId,
    before: { status: unit.status, version: unit.version },
    after: { status: result.status, version: result.version, reason: request.reason ?? null },
  });

  return result;
}

/**
 * Release reservations whose hold has expired.
 *
 * Run by the worker. Without it a lapsed reservation keeps a car off the market
 * indefinitely, which is the failure customers notice and staff cannot explain.
 */
export async function releaseExpiredReservations(db: TenantDb): Promise<number> {
  const released = await db
    .update(inventoryUnits)
    .set({
      status: 'available',
      reservedUntil: null,
      reservedForCustomerId: null,
      version: sql`${inventoryUnits.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inventoryUnits.tenantId, db.tenantId),
        eq(inventoryUnits.status, 'reserved'),
        sql`${inventoryUnits.reservedUntil} < now()`,
      ),
    )
    .returning({ id: inventoryUnits.id, stockNumber: inventoryUnits.stockNumber });

  for (const unit of released) {
    await recordAudit(db, {
      actor: { type: 'system' },
      action: 'inventory.reservation_expired',
      entityType: 'inventory_unit',
      entityId: unit.id,
      after: { status: 'available', stockNumber: unit.stockNumber },
    });
  }

  return released.length;
}

const LABELS: Record<InventoryStatus, string> = {
  available: 'available',
  reserved: 'reserved',
  pending_delivery: 'pending delivery',
  sold: 'sold',
  service_hold: 'on service hold',
  unavailable: 'unavailable',
};

function label(status: InventoryStatus): string {
  return LABELS[status] ?? status;
}
