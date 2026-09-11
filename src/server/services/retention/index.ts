import 'server-only';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { conversations, messages, tenantSettings, accessTokens } from '@/server/db/schema';
import { withTenant } from '@/server/db/tenant-db';
import { recordAudit } from '@/server/services/audit';

/**
 * Retention (docs/04-spec-review.md §10).
 *
 * Conversations hold names, phone numbers, budgets and trade-in details. Spec
 * §31 covers consent but says nothing about how long any of it is kept, so
 * without this they are kept forever.
 *
 * What is removed and what is not matters:
 *
 *   REDACTED  message bodies and tool payloads — the raw personal data
 *   KEPT      the lead, the appointment, the ticket, the audit trail
 *
 * A dealership still needs to know it sold someone a car. It does not need the
 * transcript of the conversation two years later.
 */

const DEFAULT_RETENTION_MONTHS = 24;

export interface RetentionReport {
  conversationsRedacted: number;
  messagesRedacted: number;
  tokensExpired: number;
}

export async function applyRetention(tenantId: string, now = new Date()): Promise<RetentionReport> {
  return withTenant(tenantId, async (db) => {
    const [settings] = await db
      .select({ lead: tenantSettings.lead })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, db.tenantId))
      .limit(1);

    const months =
      (settings?.lead as { conversationRetentionMonths?: number } | undefined)
        ?.conversationRetentionMonths ?? DEFAULT_RETENTION_MONTHS;

    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - months);

    const due = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.tenantId, db.tenantId),
          lt(conversations.lastMessageAt, cutoff),
          isNull(conversations.redactedAt),
        ),
      )
      .limit(200);

    let messagesRedacted = 0;

    for (const conversation of due) {
      const redacted = await db
        .update(messages)
        .set({ content: null, toolInput: null, toolResult: null })
        .where(
          and(
            eq(messages.tenantId, db.tenantId),
            eq(messages.conversationId, conversation.id),
          ),
        )
        .returning({ id: messages.id });

      messagesRedacted += redacted.length;

      await db
        .update(conversations)
        .set({ redactedAt: now, rollingSummary: null })
        .where(
          and(eq(conversations.tenantId, db.tenantId), eq(conversations.id, conversation.id)),
        );

      // Auditing the redaction is the point: the record of what was removed
      // has to outlive the thing removed.
      await recordAudit(db, {
        actor: { type: 'system' },
        action: 'conversation.redacted',
        entityType: 'conversation',
        entityId: conversation.id,
        after: { messagesRedacted: redacted.length, retentionMonths: months },
      });
    }

    // Expired single-use links are of no further use to anyone.
    const expired = await db
      .delete(accessTokens)
      .where(and(eq(accessTokens.tenantId, db.tenantId), lt(accessTokens.expiresAt, now)))
      .returning({ id: accessTokens.id });

    return {
      conversationsRedacted: due.length,
      messagesRedacted,
      tokensExpired: expired.length,
    };
  });
}

/**
 * Erase one customer on request.
 *
 * Personal data is removed; the transactional shape is kept, because a
 * dealership has records it must retain. Deliberately explicit rather than a
 * cascade delete — a cascade would take the appointment and the ticket with it.
 */
export async function eraseCustomer(
  tenantId: string,
  customerId: string,
  requestedBy: { type: 'staff' | 'customer'; id?: string },
): Promise<void> {
  await withTenant(tenantId, async (db) => {
    await db.execute(sql`
      UPDATE customers SET
        full_name = NULL, email = NULL, phone = NULL,
        marketing_consent = false, contact_consent = false
      WHERE tenant_id = ${db.tenantId} AND id = ${customerId}
    `);

    await db.execute(sql`
      UPDATE messages SET content = NULL, tool_input = NULL, tool_result = NULL
      WHERE tenant_id = ${db.tenantId}
        AND conversation_id IN (
          SELECT id FROM conversations WHERE customer_id = ${customerId}
        )
    `);

    await recordAudit(db, {
      actor: requestedBy.type === 'staff' ? { type: 'staff', id: requestedBy.id! } : { type: 'system' },
      action: 'customer.erased',
      entityType: 'customer',
      entityId: customerId,
    });
  });
}
