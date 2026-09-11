import 'server-only';
import { createHash } from 'node:crypto';
import { auditLogs } from '@/server/db/schema';
import type { TenantDb } from '@/server/db/tenant-db';

/**
 * Audit logging (spec §28).
 *
 * Writes go through the SAME transaction as the change they describe, which is
 * why this takes a `TenantDb` rather than opening its own. An audit row that
 * can commit while its subject rolls back is worse than no audit row: it
 * records something that never happened.
 *
 * The table is append-only at the grant level, so this module cannot amend or
 * remove history even if asked to.
 */

export type AuditActor =
  | { type: 'staff'; id: string }
  | { type: 'customer'; id: string }
  | { type: 'ai'; id?: string }
  | { type: 'system' };

export interface AuditEntry {
  actor: AuditActor;
  /** Dotted, past tense: `lead.status.changed`, `inventory.reserved`. */
  action: string;
  entityType: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  requestId?: string;
  ip?: string;
}

/** IPs are hashed, never stored raw: enough to correlate abuse, not to track. */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export async function recordAudit(db: TenantDb, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    tenantId: db.tenantId,
    actorType: entry.actor.type,
    actorId: 'id' in entry.actor ? (entry.actor.id ?? null) : null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    requestId: entry.requestId ?? null,
    ipHash: hashIp(entry.ip),
  });
}

/**
 * Diff helper for update audits: records only what actually changed, so a
 * timeline shows "status: new -> contacted" rather than the whole row twice.
 */
export function changedFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Partial<T>; after: Partial<T> } | null {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  let changed = false;

  for (const key of Object.keys(after) as (keyof T)[]) {
    const nextValue = after[key];
    if (nextValue === undefined) continue;
    if (!Object.is(before[key], nextValue)) {
      b[key] = before[key];
      a[key] = nextValue;
      changed = true;
    }
  }
  return changed ? { before: b, after: a } : null;
}
