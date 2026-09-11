import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantDb } from '@/server/db/tenant-db';

/**
 * Ticket numbers: {PREFIX}-{YYYY}-{SEQ}, e.g. SIN-2026-10482.
 *
 * Allocated by a row-locked counter inside the CREATING transaction, so numbers
 * are gapless per tenant and two concurrent requests cannot collide. Sequences
 * are per tenant, so one dealership's ticket volume is not inferable from
 * another's numbers — which a shared global sequence would leak.
 */
export async function allocateTicketNumber(
  db: TenantDb,
  options: { prefix: string; now?: Date },
): Promise<string> {
  const period = String((options.now ?? new Date()).getUTCFullYear());

  // UPDATE ... RETURNING takes the row lock and increments atomically. The
  // INSERT handles the first ticket of a new year; ON CONFLICT makes two
  // concurrent first-tickets safe.
  const rows = (await db.execute(sql`
    INSERT INTO ticket_sequences (tenant_id, period, next_value)
    VALUES (${db.tenantId}, ${period}, 10002)
    ON CONFLICT (tenant_id, period)
      DO UPDATE SET next_value = ticket_sequences.next_value + 1
    RETURNING next_value - 1 AS allocated
  `)) as unknown as Array<{ allocated: number }>;

  const allocated = rows[0]?.allocated ?? 10001;
  return `${options.prefix}-${period}-${allocated}`;
}
