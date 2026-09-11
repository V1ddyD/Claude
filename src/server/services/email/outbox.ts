import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { emailMessages, emailEvents, tenantSettings, tenants } from '@/server/db/schema';
import { withTenant } from '@/server/db/tenant-db';
import { listActiveTenantIds } from '@/server/db/control-plane';
import { emailProvider } from './provider';
import { renderTemplate } from './templates';

/**
 * Draining the outbox.
 *
 * The whole point of the design (docs/00-architecture.md §9): a message is
 * written in the business transaction and only leaves `queued` when the
 * provider actually accepts it. Nothing in the system may report an email as
 * sent before this function has been told so by the provider.
 *
 * Status: queued -> sending -> accepted -> delivered | bounced
 *                           -> failed (retryable, backs off) | suppressed
 */

const MAX_ATTEMPTS = 5;

export interface DrainReport {
  claimed: number;
  accepted: number;
  failed: number;
}

/**
 * Drain the outbox for one tenant, or for every tenant when none is named.
 *
 * Scoped per tenant because the worker runs as the application role under RLS —
 * there is no cross-tenant view of the outbox, and a bug that produced one
 * would be a bug that could send one dealership's mail from another's address.
 */
export async function drainOutbox(tenantId?: string, limit = 20): Promise<DrainReport> {
  if (!tenantId) {
    const report: DrainReport = { claimed: 0, accepted: 0, failed: 0 };
    for (const id of await listActiveTenantIds()) {
      const part = await drainOutbox(id, limit);
      report.claimed += part.claimed;
      report.accepted += part.accepted;
      report.failed += part.failed;
    }
    return report;
  }

  const due = await withTenant(tenantId, async (db) => {
    const rows = (await db.execute(sql`
      UPDATE email_messages SET status = 'sending', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM email_messages
        WHERE status = 'queued' AND scheduled_for <= now() AND tenant_id = ${tenantId}
        ORDER BY scheduled_for
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id, tenant_id AS "tenantId", template_key AS "templateKey",
                to_email AS "toEmail", to_name AS "toName", subject, payload, attempts
    `)) as unknown as Array<{
      id: string;
      tenantId: string;
      templateKey: string;
      toEmail: string;
      toName: string | null;
      subject: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>;
    return rows;
  });

  let accepted = 0;
  let failed = 0;

  for (const message of due) {
    const settled = await sendOne(message);
    if (settled) accepted++;
    else failed++;
  }

  return { claimed: due.length, accepted, failed };
}

async function sendOne(message: {
  id: string;
  tenantId: string;
  templateKey: string;
  toEmail: string;
  toName: string | null;
  subject: string;
  payload: Record<string, unknown>;
  attempts: number;
}): Promise<boolean> {
  return withTenant(message.tenantId, async (db) => {
    const [tenant] = await db
      .select({ brandName: tenants.brandName })
      .from(tenants)
      .where(eq(tenants.id, message.tenantId))
      .limit(1);

    const [settings] = await db
      .select({ email: tenantSettings.email })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, message.tenantId))
      .limit(1);

    const config = (settings?.email ?? {}) as {
      fromName?: string;
      fromAddress?: string;
      replyTo?: string;
    };

    // Without a configured sender there is nothing legitimate to send from.
    // Suppressed rather than retried: attempting again changes nothing.
    if (!config.fromAddress) {
      await db
        .update(emailMessages)
        .set({ status: 'suppressed', lastError: 'No sender address configured' })
        .where(and(eq(emailMessages.tenantId, db.tenantId), eq(emailMessages.id, message.id)));
      return false;
    }

    const rendered = renderTemplate(message.templateKey, message.subject, {
      brandName: tenant?.brandName ?? 'The dealership',
      customerName: message.toName,
      payload: message.payload,
    });

    const result = await emailProvider().send({
      to: message.toEmail,
      toName: message.toName,
      from: config.fromAddress,
      fromName: config.fromName ?? tenant?.brandName ?? 'Sales',
      replyTo: config.replyTo,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });

    if (result.accepted) {
      await db
        .update(emailMessages)
        .set({
          status: 'accepted',
          providerMessageId: result.providerMessageId,
          acceptedAt: new Date(),
          lastError: null,
        })
        .where(and(eq(emailMessages.tenantId, db.tenantId), eq(emailMessages.id, message.id)));

      await db.insert(emailEvents).values({
        tenantId: db.tenantId,
        emailMessageId: message.id,
        type: 'accepted',
      });
      return true;
    }

    const exhausted = !result.retryable || message.attempts >= MAX_ATTEMPTS;

    await db
      .update(emailMessages)
      .set({
        status: exhausted ? 'failed' : 'queued',
        lastError: result.error.slice(0, 1000),
        // Exponential backoff on a retry, so a provider outage does not become
        // a tight loop against it.
        scheduledFor: exhausted
          ? undefined
          : new Date(Date.now() + Math.min(2 ** message.attempts, 60) * 60_000),
      })
      .where(and(eq(emailMessages.tenantId, db.tenantId), eq(emailMessages.id, message.id)));

    return false;
  });
}

/**
 * Apply a provider webhook.
 *
 * `delivered` and `bounced` can only ever come from here: no code path lets the
 * application decide an email arrived.
 */
export async function applyDeliveryEvent(params: {
  providerMessageId: string;
  type: 'delivered' | 'bounced' | 'complained';
  payload?: unknown;
}): Promise<boolean> {
  // The provider's id carries no tenant, so the owning tenant is found by
  // asking each in turn under its own context rather than by querying across
  // them. Slower, and it keeps the isolation boundary intact.
  for (const tenantId of await listActiveTenantIds()) {
    const found = await withTenant(tenantId, async (scoped) => {
      const rows = await scoped
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.tenantId, scoped.tenantId),
            eq(emailMessages.providerMessageId, params.providerMessageId),
          ),
        )
        .limit(1);

      const message = rows[0];
      if (!message) return false;

      await scoped
        .update(emailMessages)
        .set({
          status: params.type === 'delivered' ? 'delivered' : 'bounced',
          deliveredAt: params.type === 'delivered' ? new Date() : undefined,
        })
        .where(
          and(eq(emailMessages.tenantId, scoped.tenantId), eq(emailMessages.id, message.id)),
        );

      await scoped.insert(emailEvents).values({
        tenantId: scoped.tenantId,
        emailMessageId: message.id,
        type: params.type,
        providerPayload: (params.payload ?? null) as never,
      });
      return true;
    });

    if (found) return true;
  }
  return false;
}

/** Used by the portal to show staff what happened, never shown to customers. */
export async function outboxStatus(tenantId: string) {
  return withTenant(tenantId, async (db) => {
    const rows = await db
      .select({ status: emailMessages.status, count: sql<number>`count(*)::int` })
      .from(emailMessages)
      .where(eq(emailMessages.tenantId, db.tenantId))
      .groupBy(emailMessages.status);
    return rows;
  });
}
