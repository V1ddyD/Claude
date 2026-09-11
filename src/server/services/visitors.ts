import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { visitors } from '@/server/db/schema';
import { withTenant, type TenantDb } from '@/server/db/tenant-db';

/**
 * The anonymous browsing identity.
 *
 * A stranger opening the chat is the product's central flow, so there must be
 * something to attach a conversation to before anyone has given a name. A
 * visitor row carries no PII — it exists to link a browser session to its own
 * conversations and saved builds, and nothing else (docs/00-architecture.md §3).
 *
 * It is linked to a customer only once the person identifies themselves.
 */
export async function ensureVisitor(
  db: TenantDb,
  visitorId?: string | null,
): Promise<string> {
  if (visitorId) {
    const existing = await db
      .select({ id: visitors.id })
      .from(visitors)
      .where(and(eq(visitors.tenantId, db.tenantId), eq(visitors.id, visitorId)))
      .limit(1);

    if (existing[0]) {
      await db
        .update(visitors)
        .set({ lastSeenAt: sql`now()` })
        .where(and(eq(visitors.tenantId, db.tenantId), eq(visitors.id, visitorId)));
      return existing[0].id;
    }
    // A cookie naming a visitor this tenant has never seen — cleared data, a
    // different dealership, a forged value. Mint a fresh one rather than trust it.
  }

  const created = await db
    .insert(visitors)
    .values({ tenantId: db.tenantId })
    .returning({ id: visitors.id });

  return created[0]!.id;
}

/** Convenience for callers that do not already hold a transaction. */
export async function ensureVisitorForTenant(
  tenantId: string,
  visitorId?: string | null,
): Promise<string> {
  return withTenant(tenantId, (db) => ensureVisitor(db, visitorId));
}

/** Links a visitor to the customer they turned out to be. */
export async function linkVisitorToCustomer(
  db: TenantDb,
  visitorId: string,
  customerId: string,
): Promise<void> {
  await db
    .update(visitors)
    .set({ customerId })
    .where(and(eq(visitors.tenantId, db.tenantId), eq(visitors.id, visitorId)));
}
