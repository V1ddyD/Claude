import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { channelAccounts, channelMessages, type MessagingChannel } from '@/server/db/schema';
import { withTenant, type TenantDb } from '@/server/db/tenant-db';
import { listActiveTenantIds } from '@/server/db/control-plane';
import { channelProvider, isWindowClosed } from './provider';

/**
 * The outbound side of a messaging channel.
 *
 * Deliberately the same shape as `services/email/outbox.ts`: a row is written
 * in the business transaction, and only leaves `queued` when the platform
 * actually accepts it. A reply cannot be sent for a turn that rolled back, and
 * a platform outage delays a message rather than losing it.
 *
 * Status: queued -> sending -> accepted
 *                           -> queued (retryable, backs off)
 *                           -> failed  (retries exhausted)
 *                           -> expired (the 24-hour window closed)
 */

export interface QueuedChannelMessage {
  channel: MessagingChannel;
  channelAccountId: string;
  conversationId: string;
  recipientExternalId: string;
  body: string;
  sentByType?: 'ai' | 'staff' | 'system';
  sentById?: string;
}

/**
 * Queue a reply inside the caller's transaction.
 *
 * Takes a TenantDb rather than opening its own, which is the point: a message
 * scheduled for a conversation turn that rolls back must roll back with it.
 *
 * The dedupe key is derived from the conversation and the body, so a retried
 * turn reuses its message instead of sending the customer the same sentence
 * twice. `onConflictDoNothing` makes that a no-op rather than an error the
 * caller has to distinguish from a real failure.
 */
export async function queueChannelMessage(
  db: TenantDb,
  message: QueuedChannelMessage,
): Promise<void> {
  const dedupeKey = createHash('sha256')
    .update([message.conversationId, message.recipientExternalId, message.body].join('|'))
    .digest('hex')
    .slice(0, 48);

  await db
    .insert(channelMessages)
    .values({
      tenantId: db.tenantId,
      channel: message.channel,
      channelAccountId: message.channelAccountId,
      conversationId: message.conversationId,
      recipientExternalId: message.recipientExternalId,
      body: message.body,
      sentByType: message.sentByType ?? 'ai',
      sentById: message.sentById,
      dedupeKey,
    })
    .onConflictDoNothing();
}

export interface ChannelDrainReport {
  claimed: number;
  accepted: number;
  failed: number;
}

/**
 * Drain the outbox for one tenant, or for every tenant when none is named.
 *
 * Scoped per tenant because the worker runs as the application role under RLS.
 * A bug producing a cross-tenant view here would be a bug that could send one
 * dealership's reply from another dealership's Instagram account.
 */
export async function drainChannelOutbox(
  tenantId?: string,
  limit = 20,
): Promise<ChannelDrainReport> {
  if (!tenantId) {
    const report: ChannelDrainReport = { claimed: 0, accepted: 0, failed: 0 };
    for (const id of await listActiveTenantIds()) {
      const part = await drainChannelOutbox(id, limit);
      report.claimed += part.claimed;
      report.accepted += part.accepted;
      report.failed += part.failed;
    }
    return report;
  }

  const due = await withTenant(tenantId, async (db) => {
    const rows = (await db.execute(sql`
      UPDATE channel_messages SET status = 'sending', attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM channel_messages
        WHERE status = 'queued' AND scheduled_for <= now() AND tenant_id = ${tenantId}
        ORDER BY scheduled_for
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING id, tenant_id AS "tenantId", channel,
                channel_account_id AS "channelAccountId",
                recipient_external_id AS "recipientExternalId",
                body, attempts, max_attempts AS "maxAttempts"
    `)) as unknown as Array<{
      id: string;
      tenantId: string;
      channel: MessagingChannel;
      channelAccountId: string | null;
      recipientExternalId: string;
      body: string;
      attempts: number;
      maxAttempts: number;
    }>;
    return rows;
  });

  let accepted = 0;
  let failed = 0;

  for (const message of due) {
    if (await sendOne(message)) accepted++;
    else failed++;
  }

  return { claimed: due.length, accepted, failed };
}

async function sendOne(message: {
  id: string;
  tenantId: string;
  channel: MessagingChannel;
  channelAccountId: string | null;
  recipientExternalId: string;
  body: string;
  attempts: number;
  maxAttempts: number;
}): Promise<boolean> {
  return withTenant(message.tenantId, async (db) => {
    const settle = (
      values: Partial<typeof channelMessages.$inferInsert>,
    ) =>
      db
        .update(channelMessages)
        .set(values)
        .where(
          and(eq(channelMessages.tenantId, db.tenantId), eq(channelMessages.id, message.id)),
        );

    const [account] = message.channelAccountId
      ? await db
          .select({
            externalAccountId: channelAccounts.externalAccountId,
            accessToken: channelAccounts.accessToken,
            isActive: channelAccounts.isActive,
          })
          .from(channelAccounts)
          .where(
            and(
              eq(channelAccounts.tenantId, db.tenantId),
              eq(channelAccounts.id, message.channelAccountId),
            ),
          )
          .limit(1)
      : [];

    // No account, no token, or the dealership disconnected it. Retrying
    // changes nothing until a person reconnects, so this fails rather than
    // looping — and it fails loudly enough for staff to see the thread stalled.
    if (!account?.accessToken || !account.isActive) {
      await settle({
        status: 'failed',
        lastError: 'No active connected account for this channel',
      });
      return false;
    }

    const result = await channelProvider().send({
      channel: message.channel,
      recipientExternalId: message.recipientExternalId,
      senderExternalId: account.externalAccountId,
      accessToken: account.accessToken,
      body: message.body,
    });

    if (result.accepted) {
      await settle({
        status: 'accepted',
        providerMessageId: result.providerMessageId,
        acceptedAt: new Date(),
        lastError: null,
      });
      return true;
    }

    // The 24-hour window closing is not an outage and not our bug — it is the
    // customer having gone quiet for a day. Recorded as its own state so the
    // portal can say the thread went cold rather than implying a delivery.
    if (isWindowClosed(result.error)) {
      await settle({ status: 'expired', lastError: result.error.slice(0, 1000) });
      return false;
    }

    const exhausted = !result.retryable || message.attempts >= message.maxAttempts;

    await settle({
      status: exhausted ? 'failed' : 'queued',
      lastError: result.error.slice(0, 1000),
      // Backed off so a platform outage does not become a tight loop against
      // it. Capped at an hour: beyond that the window has closed anyway.
      ...(exhausted
        ? {}
        : {
            scheduledFor: new Date(
              Date.now() + Math.min(2 ** message.attempts, 60) * 60_000,
            ),
          }),
    });

    return false;
  });
}
