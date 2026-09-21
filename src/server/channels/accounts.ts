import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { channelAccounts, type MessagingChannel } from '@/server/db/schema';
import { withTenant } from '@/server/db/tenant-db';

/**
 * Connecting and disconnecting a dealership's messaging account.
 *
 * This is the whole of what onboarding a channel means: one row saying which
 * platform account belongs to which dealership, and the token that lets us
 * answer as them. Everything else — the webhook, the conversation, the
 * scoring — already works the moment that row exists.
 *
 * Deliberately not a self-serve flow. The first few dealerships are connected
 * by hand, which is slower per customer and far faster overall: the manual
 * work is where you find out what the product should actually do.
 */

export interface ConnectedAccount {
  id: string;
  channel: MessagingChannel;
  externalAccountId: string;
  displayName: string | null;
  isActive: boolean;
  /** Whether a token is held. Never the token itself. */
  hasToken: boolean;
  tokenExpiresAt: Date | null;
}

export async function connectChannelAccount(params: {
  tenantId: string;
  channel: MessagingChannel;
  externalAccountId: string;
  accessToken: string;
  displayName?: string | null;
  /** Instagram's long-lived token lasts 60 days; Meta tells us how long. */
  expiresInSeconds?: number;
}): Promise<ConnectedAccount> {
  const tokenExpiresAt = params.expiresInSeconds
    ? new Date(Date.now() + params.expiresInSeconds * 1000)
    : null;

  return withTenant(params.tenantId, async (db) => {
    const rows = await db
      .insert(channelAccounts)
      .values({
        tenantId: db.tenantId,
        channel: params.channel,
        externalAccountId: params.externalAccountId,
        accessToken: params.accessToken,
        displayName: params.displayName ?? null,
        tokenExpiresAt,
        isActive: true,
      })
      // Reconnecting is the common case — a token expires every 60 days, and
      // the dealership pastes a new one. That must update the account rather
      // than fail, or the only way to refresh a token is to delete a row.
      .onConflictDoUpdate({
        target: [channelAccounts.channel, channelAccounts.externalAccountId],
        set: {
          accessToken: params.accessToken,
          displayName: params.displayName ?? null,
          tokenExpiresAt,
          isActive: true,
          updatedAt: sql`now()`,
        },
        // Scoped to the caller's own tenant: without this, the unique key is
        // global, so connecting an account another dealership already holds
        // would silently hand them ours.
        setWhere: eq(channelAccounts.tenantId, params.tenantId),
      })
      .returning({
        id: channelAccounts.id,
        channel: channelAccounts.channel,
        externalAccountId: channelAccounts.externalAccountId,
        displayName: channelAccounts.displayName,
        isActive: channelAccounts.isActive,
        tokenExpiresAt: channelAccounts.tokenExpiresAt,
      });

    const row = rows[0];
    // No row back means the conflict target matched a row belonging to
    // somebody else. Said plainly rather than reported as a success that
    // changed nothing.
    if (!row) {
      throw new Error(
        `${params.channel} account ${params.externalAccountId} is connected to another tenant`,
      );
    }

    return { ...row, hasToken: true };
  });
}

/** What a dealership has connected. Never includes a token. */
export async function listChannelAccounts(tenantId: string): Promise<ConnectedAccount[]> {
  return withTenant(tenantId, async (db) => {
    const rows = await db
      .select({
        id: channelAccounts.id,
        channel: channelAccounts.channel,
        externalAccountId: channelAccounts.externalAccountId,
        displayName: channelAccounts.displayName,
        isActive: channelAccounts.isActive,
        accessToken: channelAccounts.accessToken,
        tokenExpiresAt: channelAccounts.tokenExpiresAt,
      })
      .from(channelAccounts)
      .where(eq(channelAccounts.tenantId, db.tenantId));

    return rows.map(({ accessToken, ...rest }) => ({
      ...rest,
      hasToken: Boolean(accessToken),
    }));
  });
}

export interface ChannelActivity {
  /** Inbound platform messages we have accepted, newest first. */
  inbound: Array<{ channel: string; externalMessageId: string; receivedAt: Date }>;
  /** Conversations that arrived from a messaging channel, newest first. */
  conversations: Array<{
    id: string;
    channel: string;
    lastMessageAt: Date;
    messages: number;
  }>;
  /** Replies we have queued or sent, newest first. */
  outbound: Array<{
    status: string;
    body: string;
    lastError: string | null;
    createdAt: Date;
  }>;
}

/**
 * What has actually happened on a channel.
 *
 * Diagnosis, not a feature. When a DM produces no reply there are three very
 * different failures wearing the same face — the platform never delivered it,
 * it was delivered and not understood, or it was answered and the answer never
 * went out — and no amount of reasoning from the outside separates them.
 *
 * Each list answers one of those, in order. Empty inbound means the message
 * never arrived, and nothing downstream is worth looking at.
 */
export async function channelActivity(tenantId: string, limit = 10): Promise<ChannelActivity> {
  return withTenant(tenantId, async (db) => {
    const inbound = (await db.execute(sql`
      SELECT channel, external_message_id AS "externalMessageId", received_at AS "receivedAt"
      FROM channel_inbound_messages
      ORDER BY received_at DESC
      LIMIT ${limit}
    `)) as unknown as ChannelActivity['inbound'];

    const conversations = (await db.execute(sql`
      SELECT c.id, c.channel, c.last_message_at AS "lastMessageAt",
             (SELECT count(*)::int FROM messages m
               WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id) AS messages
      FROM conversations c
      WHERE c.tenant_id = ${tenantId}
        AND c.channel IN ('instagram', 'messenger', 'whatsapp')
      ORDER BY c.last_message_at DESC
      LIMIT ${limit}
    `)) as unknown as ChannelActivity['conversations'];

    const outbound = (await db.execute(sql`
      SELECT status, left(body, 120) AS body, last_error AS "lastError",
             created_at AS "createdAt"
      FROM channel_messages
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as ChannelActivity['outbound'];

    return { inbound, conversations, outbound };
  });
}

/**
 * Stop answering as an account.
 *
 * Deactivated rather than deleted: the conversations it carried are still the
 * dealership's, and a row that vanishes takes the explanation with it.
 */
export async function disconnectChannelAccount(
  tenantId: string,
  channel: MessagingChannel,
  externalAccountId: string,
): Promise<boolean> {
  return withTenant(tenantId, async (db) => {
    const rows = await db
      .update(channelAccounts)
      .set({ isActive: false, accessToken: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(channelAccounts.tenantId, db.tenantId),
          eq(channelAccounts.channel, channel),
          eq(channelAccounts.externalAccountId, externalAccountId),
        ),
      )
      .returning({ id: channelAccounts.id });

    return rows.length > 0;
  });
}
